"""RTSP 摄像头实时画面：浏览器不能直接播放 RTSP，由本模块用 ffmpeg 转成 MJPEG
（multipart/x-mixed-replace）后用 <img> 显示。

- ffmpeg 查找：环境变量 HOME_CONSOLE_FFMPEG → PATH 中的 ffmpeg → imageio_ffmpeg 自带二进制。
- 每打开一路画面起一个 ffmpeg 子进程（RTSP over TCP，4fps，低延迟），浏览器断开即结束进程；
  全局并发受信号量限制，避免多屏同时打开把机器拖垮。
- RTSP 地址只保存在服务端，从不发给浏览器；接口只按 custom 里的摄像头 id 取流。
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import sys

log = logging.getLogger("home_console_server")

# JPEG 帧首尾标记，用于把 ffmpeg 连续输出的 mjpeg 切成单帧。
JPEG_SOI = b"\xff\xd8"
JPEG_EOI = b"\xff\xd9"
BOUNDARY = "hcframe"
MAX_CONCURRENT = 6          # 同时转码的画面路数上限（每路一个 ffmpeg 进程）
FIRST_FRAME_TIMEOUT = 10.0  # 启动后等第一帧的秒数，超时判定连不上
FRAME_IDLE_TIMEOUT = 20.0   # 运行中两帧最大间隔，超时认为流僵死
WRITE_TIMEOUT = 8.0         # 一帧写给浏览器的最长时间；浏览器离开画面不取消请求时，缓冲堆满后靠它退出
READ_CHUNK = 8192


class CameraClientGone(RuntimeError):
    """浏览器已不再读取画面（切页 / 关闭标签后未取消 multipart 请求）。"""


def find_ffmpeg() -> str | None:
    """按 环境变量 → PATH → imageio_ffmpeg 自带二进制 的顺序找 ffmpeg。"""
    env_path = os.environ.get("HOME_CONSOLE_FFMPEG", "").strip()
    if env_path and os.path.isfile(env_path):
        return env_path
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


class CameraStreamer:
    def __init__(self) -> None:
        self.ffmpeg_path: str | None = find_ffmpeg()
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async def stream(self, rtsp_url: str, write, on_first_frame=None) -> None:
        """把一路 RTSP 转成 MJPEG 逐帧写出；on_first_frame 在收到首帧后 await 一次
        （调用方借此先确认连得上再发送响应头）。客户端断开写会抛异常，由 finally 结束 ffmpeg。"""
        if not self.ffmpeg_path:
            raise RuntimeError("服务器没有可用的 ffmpeg")
        args = [
            self.ffmpeg_path, "-loglevel", "error",
            "-rtsp_transport", "tcp",          # TCP 传 RTSP，减少花屏与丢包
            "-fflags", "nobuffer", "-flags", "low_delay",
            "-i", rtsp_url,
            "-an", "-f", "mjpeg", "-q:v", "6", "-r", "4", "-",
        ]
        kwargs: dict = {"stdout": asyncio.subprocess.PIPE, "stderr": asyncio.subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

        async with self._semaphore:
            proc = await asyncio.create_subprocess_exec(*args, **kwargs)
            assert proc.stdout is not None
            buffer = b""
            got_first = False
            loop = asyncio.get_event_loop()
            last_frame = loop.time()
            try:
                while True:
                    wait = FIRST_FRAME_TIMEOUT if not got_first else max(1.0, FRAME_IDLE_TIMEOUT - (loop.time() - last_frame))
                    chunk = await asyncio.wait_for(proc.stdout.read(READ_CHUNK), timeout=wait)
                    if chunk == b"":
                        raise RuntimeError("摄像头流已结束")
                    buffer += chunk
                    while True:
                        start = buffer.find(JPEG_SOI)
                        if start < 0:
                            buffer = b""
                            break
                        end = buffer.find(JPEG_EOI, start + 2)
                        if end < 0:
                            buffer = buffer[start:]
                            break
                        frame = buffer[start:end + 2]
                        buffer = buffer[end + 2:]
                        last_frame = loop.time()
                        if not got_first:
                            if on_first_frame is not None:
                                await on_first_frame()
                            got_first = True
                        packet = (b"--" + BOUNDARY.encode() + b"\r\n"
                                  b"Content-Type: image/jpeg\r\n"
                                  + f"Content-Length: {len(frame)}\r\n\r\n".encode()
                                  + frame + b"\r\n")
                        try:
                            # drain 超时：浏览器移除 img 后不一定取消 multiparp 请求，连接挂着不读，
                            # 发送缓冲堆满时 write 会一直等；超时即视为观众已离开，结束 ffmpeg。
                            await asyncio.wait_for(write(packet), timeout=WRITE_TIMEOUT)
                        except asyncio.TimeoutError:
                            raise CameraClientGone("客户端已停止读取画面")
            finally:
                if proc.returncode is None:
                    proc.kill()
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=3)
                    except asyncio.TimeoutError:
                        pass
