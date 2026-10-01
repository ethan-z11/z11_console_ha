"""ONVIF 摄像头的运动检测截图。

优先订阅摄像头自身的 ONVIF 事件（PullMessages）：摄像头检测到画面移动时会主动推送
Motion 事件，我们收到后抓拍一张“触发瞬间”的截图，并在 2 秒后再抓拍一张。

若摄像头不支持 / 固件 PullPoint 兼容有问题（如部分大华返回 Unknown Pullpoint），
自动回退到 ffmpeg 低帧率灰度帧差做相邻帧变化检测，同样是触发瞬间 + 2 秒后各抓一张。

- 保存位置：<数据目录>/camera-shots/<摄像头id>/YYYYmmdd_HHMMSS[_n].jpg
- 保留策略：超过 3 天（72 小时）自动删除；每台摄像头最多保留 300 张，超出删最旧的
- 摄像头删除 / 改为 RTSP 后自动停止对应的监测进程
- 有人联动：摄像头所在区域（custom.occupancy）配置了有人传感器时，只有区域有人
  才抓拍；未配置传感器的区域保持原行为（检测到运动就抓拍）
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Awaitable, Callable

from .onvif import OnvifError, OnvifManager

log = logging.getLogger("home_console_server")

MOTION_TOPIC_KEYWORDS = ("motion", "motionalarm", "cellmotion", "motionregion", "ruleengine")
CAPTURE_COOLDOWN = 30.0     # 同一摄像头两次抓拍最小间隔（秒），避免事件风暴刷屏
SECOND_CAPTURE_DELAY = 2.0  # 触发后第二张截图的延迟（秒）
# 帧差兜底参数（仅当摄像头不支持 ONVIF 事件时启用）
FRAME_WIDTH, FRAME_HEIGHT = 64, 36
FRAME_SIZE = FRAME_WIDTH * FRAME_HEIGHT
FRAME_FPS = 2
PIXEL_THRESHOLD = 24
MOTION_RATIO = 0.06
MOTION_FRAMES = 2
WARMUP_FRAMES = 10
SHOTS_TTL_SECONDS = 3 * 24 * 3600
MAX_SHOTS_PER_CAMERA = 300
MAX_MONITORS = 8
MAX_CAPTURES = 2
RECONNECT_DELAY = 15.0
CLEANUP_INTERVAL = 6 * 3600.0
SHOT_FILE_RE = re.compile(r"^\d{8}_\d{6}(?:_\d+)?\.jpg$")

# 方向：up/down/left/right/stop
PTZ_DIRECTIONS = ("up", "down", "left", "right", "stop")


class MotionScreenshotter:
    def __init__(self,
                 ffmpeg_path: str | None,
                 shots_dir: Path,
                 resolve_rtsp: Callable[[dict], Awaitable[str]],
                 onvif: OnvifManager,
                 occupied: Callable[[str], bool] | None = None) -> None:
        self._ffmpeg_path = ffmpeg_path
        self._shots_dir = shots_dir
        self._resolve_rtsp = resolve_rtsp
        self._onvif = onvif
        # 有人联动：传入 scope → 是否有人（区域未配置传感器时实现方应返回 True 放行）。
        self._occupied = occupied
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._stop_events: dict[str, asyncio.Event] = {}
        # 抓拍是“发射后不管”的任务，必须持有强引用，否则可能被 GC 提前回收。
        self._capture_tasks: set[asyncio.Task[None]] = set()
        self._monitor_semaphore = asyncio.Semaphore(MAX_MONITORS)
        self._capture_semaphore = asyncio.Semaphore(MAX_CAPTURES)
        self._cleanup_task: asyncio.Task[None] | None = None

    # ---------- 生命周期 ----------

    def sync(self, cameras: list[dict]) -> None:
        """配置变更后调用：为新增的 ONVIF 摄像头启动监测，停止已删除 / 改类型的。"""
        wanted = {camera["id"] for camera in cameras if camera.get("type") == "onvif"}
        for camera_id in list(self._tasks):
            if camera_id not in wanted:
                self._stop(camera_id)
        by_id = {camera["id"]: camera for camera in cameras}
        for camera_id in wanted:
            if camera_id not in self._tasks:
                self._start(camera_id, by_id[camera_id])

    async def start(self, cameras: list[dict]) -> None:
        self._shots_dir.mkdir(parents=True, exist_ok=True)
        self.sync(cameras)
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop_all(self) -> None:
        if self._cleanup_task is not None:
            self._cleanup_task.cancel()
            self._cleanup_task = None
        for camera_id in list(self._tasks):
            self._stop(camera_id)
        await asyncio.gather(*[task for task in self._tasks.values()], return_exceptions=True)
        # 给在途抓拍一点时间把 JPEG 落盘，避免留下 .tmp。
        if self._capture_tasks:
            await asyncio.wait(self._capture_tasks, timeout=10)
        self._tasks.clear()
        self._stop_events.clear()

    def _start(self, camera_id: str, camera: dict) -> None:
        event = asyncio.Event()
        self._stop_events[camera_id] = event
        self._tasks[camera_id] = asyncio.create_task(self._monitor(camera_id, camera, event))

    def _stop(self, camera_id: str) -> None:
        event = self._stop_events.pop(camera_id, None)
        if event is not None:
            event.set()
        task = self._tasks.pop(camera_id, None)
        if task is not None:
            task.cancel()

    # ---------- 监测（摄像头 ONVIF 事件驱动） ----------

    async def _monitor(self, camera_id: str, camera: dict, stop_event: asyncio.Event) -> None:
        name = camera.get("name", camera_id)
        log.info("摄像头 %s 的运动监测已启动（订阅 ONVIF 事件）", name)
        try:
            while not stop_event.is_set():
                rtsp_url: str | None = None
                try:
                    rtsp_url = await self._resolve_rtsp(camera)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    log.info("摄像头 %s 取流地址失败，%s 秒后重试：%s", name, int(RECONNECT_DELAY), error)
                if rtsp_url is None:
                    if stop_event.is_set():
                        break
                    try:
                        await asyncio.wait_for(stop_event.wait(), RECONNECT_DELAY)
                    except asyncio.TimeoutError:
                        pass
                    continue
                try:
                    async with self._monitor_semaphore:
                        if stop_event.is_set():
                            break
                        # 优先用摄像头自身的 ONVIF 事件；不支持 / 固件有兼容问题时回退到帧差。
                        try:
                            await self._run_events(camera_id, name, camera, rtsp_url, stop_event)
                        except OnvifError as error:
                            log.info("摄像头 %s 不支持 ONVIF 事件（%s），改用帧差兜底", name, error)
                            await self._run_ffmpeg_fallback(camera_id, name, rtsp_url, stop_event)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    log.info("摄像头 %s 运动监测中断，%s 秒后重连：%s", name, int(RECONNECT_DELAY), error)
                if stop_event.is_set():
                    break
                try:
                    await asyncio.wait_for(stop_event.wait(), RECONNECT_DELAY)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            pass
        finally:
            log.info("摄像头 %s 的运动监测已停止", name)

    def _motion_allowed(self, camera: dict) -> bool:
        """有人联动门控：所在区域配置了有人传感器时，只有区域有人才允许抓拍。"""
        if self._occupied is None:
            return True
        return self._occupied(str(camera.get("scope") or "home"))

    async def _run_events(self, camera_id: str, name: str, camera: dict, rtsp_url: str, stop_event: asyncio.Event) -> None:
        pullpoint_url = await self._onvif.event_pullpoint(camera)
        last_capture = 0.0
        while not stop_event.is_set():
            try:
                messages = await asyncio.wait_for(
                    self._onvif.pull_messages(camera, pullpoint_url, timeout_seconds=30), timeout=35.0)
            except asyncio.TimeoutError:
                continue
            except OnvifError:
                # 事件拉取失败（如某些固件 PullPoint 会话不持久），交给外层回退到帧差兜底。
                raise
            if not self._is_motion(messages):
                continue
            # 门控放在冷却计时之前：无人期间的事件不占用冷却窗口，人来后第一次运动即可抓拍。
            if not self._motion_allowed(camera):
                continue
            now = time.monotonic()
            if now - last_capture < CAPTURE_COOLDOWN:
                continue
            last_capture = now
            # 触发瞬间抓一张，2 秒后再抓一张。
            self._schedule_capture(camera_id, name, rtsp_url)
            self._schedule_capture(camera_id, name, rtsp_url, delay=SECOND_CAPTURE_DELAY)

    async def _run_ffmpeg_fallback(self, camera_id: str, name: str, rtsp_url: str, stop_event: asyncio.Event) -> None:
        """摄像头不支持 ONVIF 事件时的兜底：用 ffmpeg 压成低帧率灰度流做相邻帧差。"""
        if not self._ffmpeg_path:
            raise RuntimeError("服务器没有可用的 ffmpeg")
        args = [
            self._ffmpeg_path, "-loglevel", "error",
            "-rtsp_transport", "tcp",
            "-fflags", "nobuffer", "-flags", "low_delay",
            "-i", rtsp_url, "-an",
            "-vf", f"fps={FRAME_FPS},scale={FRAME_WIDTH}:{FRAME_HEIGHT},format=gray",
            "-f", "rawvideo", "-",
        ]
        kwargs: dict = {"stdout": asyncio.subprocess.PIPE, "stderr": asyncio.subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = await asyncio.create_subprocess_exec(*args, **kwargs)
        assert proc.stdout is not None
        previous: bytes | None = None
        warmup = WARMUP_FRAMES
        motion_streak = 0
        last_capture = 0.0
        try:
            while not stop_event.is_set():
                try:
                    frame = await asyncio.wait_for(proc.stdout.readexactly(FRAME_SIZE), timeout=20.0)
                except asyncio.IncompleteReadError as error:
                    raise RuntimeError(f"灰度流提前结束（收到 {len(error.partial)} 字节）")
                except asyncio.TimeoutError:
                    raise RuntimeError("灰度流长时间没有画面")
                if warmup > 0:
                    warmup -= 1
                    previous = frame
                    continue
                changed = sum(1 for index in range(0, FRAME_SIZE, 2)
                              if abs(frame[index] - (previous[index] if previous else frame[index])) > PIXEL_THRESHOLD)
                ratio = changed / (FRAME_SIZE / 2)
                previous = frame
                motion_streak = motion_streak + 1 if ratio >= MOTION_RATIO else 0
                now = time.monotonic()
                if motion_streak >= MOTION_FRAMES and now - last_capture >= CAPTURE_COOLDOWN and self._motion_allowed(camera):
                    motion_streak = 0
                    last_capture = now
                    self._schedule_capture(camera_id, name, rtsp_url)
                    self._schedule_capture(camera_id, name, rtsp_url, delay=SECOND_CAPTURE_DELAY)
        finally:
            if proc.returncode is None:
                proc.kill()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=3)
                except asyncio.TimeoutError:
                    pass

    @staticmethod
    def _is_motion(messages: list[dict]) -> bool:
        for message in messages:
            topic = (message.get("topic") or "").lower()
            if any(keyword in topic for keyword in MOTION_TOPIC_KEYWORDS):
                return True
        return False

    def _schedule_capture(self, camera_id: str, name: str, rtsp_url: str, delay: float = 0.0) -> None:
        async def _do() -> None:
            if delay > 0:
                await asyncio.sleep(delay)
            await self._capture(camera_id, name, rtsp_url)
        task = asyncio.create_task(_do())
        self._capture_tasks.add(task)
        task.add_done_callback(self._capture_tasks.discard)

    # ---------- 抓拍 ----------

    async def _capture(self, camera_id: str, name: str, rtsp_url: str) -> None:
        if not self._ffmpeg_path:
            return
        target_dir = self._shots_dir / camera_id
        target_dir.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d_%H%M%S")
        final_path = self._unique_path(target_dir, stamp)
        temp_path = final_path.with_suffix(".jpg.tmp")
        args = [
            self._ffmpeg_path, "-loglevel", "error", "-y",
            "-rtsp_transport", "tcp", "-fflags", "nobuffer",
            "-i", rtsp_url,
            "-frames:v", "1", "-an", "-q:v", "4",
            "-f", "image2", str(temp_path),
        ]
        kwargs: dict = {"stdout": asyncio.subprocess.DEVNULL, "stderr": asyncio.subprocess.PIPE}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        async with self._capture_semaphore:
            stderr = b""
            try:
                proc = await asyncio.create_subprocess_exec(*args, **kwargs)
                _, stderr = await asyncio.wait_for(proc.communicate(), timeout=15.0)
            except (asyncio.TimeoutError, OSError) as error:
                log.info("摄像头 %s 抓拍失败：%s", name, error)
                temp_path.unlink(missing_ok=True)
                return
        if proc.returncode != 0 or not temp_path.exists() or temp_path.stat().st_size < 1024:
            detail = stderr.decode("utf-8", "ignore").strip()[:200]
            log.info("摄像头 %s 抓拍失败：ffmpeg %s %s", name, proc.returncode, detail)
            temp_path.unlink(missing_ok=True)
            return
        os.replace(temp_path, final_path)
        self._enforce_cap(target_dir)
        log.info("摄像头 %s 检测到运动，已保存截图 %s", name, final_path.name)

    @staticmethod
    def _unique_path(directory: Path, stamp: str) -> Path:
        path = directory / f"{stamp}.jpg"
        suffix = 1
        while path.exists():
            path = directory / f"{stamp}_{suffix}.jpg"
            suffix += 1
        return path

    @staticmethod
    def _enforce_cap(directory: Path) -> None:
        files = sorted(directory.glob("*.jpg"), key=lambda item: item.name)
        for old in files[:-MAX_SHOTS_PER_CAMERA] if len(files) > MAX_SHOTS_PER_CAMERA else []:
            old.unlink(missing_ok=True)

    # ---------- 清理与浏览 ----------

    async def _cleanup_loop(self) -> None:
        self.cleanup()
        while True:
            await asyncio.sleep(CLEANUP_INTERVAL)
            try:
                self.cleanup()
            except Exception as error:  # 清理失败不能影响监测
                log.warning("清理运动截图失败：%s", error)

    def cleanup(self) -> None:
        """删除超过 3 天的截图与空的摄像头目录；服务启动时也跑一遍。"""
        if not self._shots_dir.exists():
            return
        now = time.time()
        for camera_dir in self._shots_dir.iterdir():
            if not camera_dir.is_dir():
                continue
            for path in camera_dir.iterdir():
                if path.is_file() and (path.suffix in (".jpg", ".tmp")) and now - path.stat().st_mtime > SHOTS_TTL_SECONDS:
                    path.unlink(missing_ok=True)
            self._enforce_cap(camera_dir)
            try:
                next(camera_dir.iterdir())
            except StopIteration:
                camera_dir.rmdir()

    def list_shots(self, camera_id: str) -> list[dict[str, str]]:
        """按时间倒序列出某台摄像头的截图（文件名即时间戳）。"""
        camera_dir = self._shots_dir / camera_id
        if not camera_dir.is_dir():
            return []
        files = [path.name for path in camera_dir.iterdir()
                 if path.is_file() and SHOT_FILE_RE.fullmatch(path.name)]
        return [{"file": name, "time": self._shot_time(name)} for name in sorted(files, reverse=True)]

    def shot_path(self, camera_id: str, file_name: str) -> Path | None:
        """取单张截图的绝对路径；文件名不合规或不存在时返回 None（防路径穿越）。"""
        if not SHOT_FILE_RE.fullmatch(file_name):
            return None
        path = (self._shots_dir / camera_id / file_name).resolve()
        base = (self._shots_dir / camera_id).resolve()
        if base not in path.parents or not path.is_file():
            return None
        return path

    @staticmethod
    def _shot_time(name: str) -> str:
        # YYYYmmdd_HHMMSS.jpg → YYYY-MM-DD HH:MM:SS
        return f"{name[0:4]}-{name[4:6]}-{name[6:8]} {name[9:11]}:{name[11:13]}:{name[13:15]}"
