import { Cctv, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Image as ImageIcon, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { apiPath } from '../consoleApi';
import type { CameraConfig } from '../consoleClient';
import { cameraType } from '../consoleClient';
import { openModalQuietly, releasePointerFocus } from '../focus';
import { AdaptiveGrid } from './AdaptiveGrid';
import { TileFrame } from './TileFrame';

type LoadState = 'loading' | 'live' | 'error';

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

function indexOfPair(data: Uint8Array, pair: number[], from = 0): number {
  for (let i = from; i < data.length - 1; i += 1) {
    if (data[i] === pair[0] && data[i + 1] === pair[1]) return i;
  }
  return -1;
}

/**
 * 用 fetch 手动消费后端的 MJPEG 流并按 JPEG 首尾标记切帧（<img src> 在组件卸载时浏览器
 * 不一定取消请求，会导致后端 ffmpeg 一直转；fetch + AbortController 能在不可见 / 卸载时
 * 立即断开）。每帧转成 blob URL 给 <img> 显示，4fps 低帧率开销很小。
 */
function useMjpegFrame(cameraId: string, active: boolean, reloadKey: number, imageRef: RefObject<HTMLImageElement | null>): LoadState {
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let ended = false;
    setState('loading');

    async function consume() {
      let response: Response;
      try {
        response = await fetch(apiPath(`/api/camera-stream?cid=${encodeURIComponent(cameraId)}&k=${reloadKey}`), { signal: controller.signal });
      } catch {
        // 主动 abort（重试 / 离开）不算错误。
        if (!ended) setState('error');
        return;
      }
      if (!response.ok || !response.body) {
        setState('error');
        return;
      }
      const reader = response.body.getReader();
      let buffer = new Uint8Array(0);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const merged = new Uint8Array(buffer.length + value.length);
          merged.set(buffer, 0);
          merged.set(value, buffer.length);
          buffer = merged;
          // 一帧 = FFD8 … FFD9；ffmpeg 输出的 JPEG 内部不会出现裸 FFD9（字节填充规范）。
          for (;;) {
            const start = indexOfPair(buffer, SOI);
            if (start < 0) { buffer = new Uint8Array(0); break; }
            const end = indexOfPair(buffer, EOI, start + 2);
            if (end < 0) { buffer = buffer.slice(start); break; }
            const frame = buffer.slice(start, end + 2);
            buffer = buffer.slice(end + 2);
            const nextUrl = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
            const previous = objectUrl;
            objectUrl = nextUrl;
            if (imageRef.current) imageRef.current.src = nextUrl;
            if (previous) URL.revokeObjectURL(previous);
            setState('live');
          }
        }
        // 流正常结束但没被主动取消：按错误显示，让用户可以重试。
        if (!ended) setState('error');
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError' && !ended) setState('error');
      } finally {
        // cancel 与 abort 竞争时会抛异步 rejection（AbortError），不再有人读取，显式吞掉避免控制台噪音。
        void reader.cancel().catch(() => { /* 已取消 */ });
      }
    }

    void consume();
    return () => {
      ended = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [cameraId, active, reloadKey, imageRef]);

  return state;
}

/** 一路 MJPEG 画面：拉流 / 加载 / 失败重试 / 暂停占位；卡片与弹窗共用。 */
function CameraStream({ cameraId, active, fit }: { cameraId: string; active: boolean; fit: 'cover' | 'contain' }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const state = useMjpegFrame(cameraId, active, reloadKey, imageRef);

  return (
    <div className={`camera-stream camera-stream--${fit}`}>
      {active
        ? <img ref={imageRef} alt="" />
        : <div className="camera-stream__paused"><Cctv size={26} /><span>画面已暂停</span></div>}
      {state === 'loading' && active && (
        <div className="camera-stream__overlay"><RefreshCw size={20} className="camera-stream__spin" /><span>正在连接摄像头…</span></div>
      )}
      {state === 'error' && active && (
        <div className="camera-stream__overlay camera-stream__overlay--error">
          <Cctv size={24} /><span>连不上摄像头<br /><small>检查地址、账号密码或网络</small></span>
          <button type="button" className="small-button" onClick={() => setReloadKey((key) => key + 1)}><RefreshCw size={14} />重试</button>
        </div>
      )}
    </div>
  );
}

type PtzDirection = 'up' | 'down' | 'left' | 'right';

/** ONVIF 云台十字方向键：按住开始连续转动，松手 / 离开自动停止；弹窗关闭也会补发停止。 */
function PtzPad({ cameraId }: { cameraId: string }) {
  const [activeDir, setActiveDir] = useState<PtzDirection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeDirRef = useRef<PtzDirection | null>(null);
  activeDirRef.current = activeDir;

  const send = useCallback(async (direction: PtzDirection | 'stop') => {
    try {
      const response = await fetch(apiPath('/api/camera-ptz'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: cameraId, direction }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? `控制失败（${response.status}）`);
      }
      setError(null);
    } catch (reason) {
      // 停止指令失败不打扰用户。
      if (direction !== 'stop') setError((reason as Error).message);
    }
  }, [cameraId]);

  useEffect(() => () => { void send('stop'); }, [send]);

  const holdProps = (direction: PtzDirection) => ({
    type: 'button' as const,
    className: `camera-ptz__key${activeDir === direction ? ' camera-ptz__key--active' : ''}`,
    'aria-label': { up: '向上转', down: '向下转', left: '向左转', right: '向右转' }[direction],
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setActiveDir(direction);
      void send(direction);
    },
    onPointerUp: () => { if (activeDirRef.current === direction) { setActiveDir(null); void send('stop'); } },
    onPointerCancel: () => { setActiveDir(null); void send('stop'); },
    onLostPointerCapture: () => { if (activeDirRef.current === direction) { setActiveDir(null); void send('stop'); } },
    onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
  });

  return (
    <div className="camera-ptz">
      <div className="camera-ptz__pad" role="group" aria-label="云台方向控制（按住转动）">
        <span />
        <button {...holdProps('up')}><ChevronUp size={22} /></button>
        <span />
        <button {...holdProps('left')}><ChevronLeft size={22} /></button>
        <span className="camera-ptz__center" aria-hidden="true"><Cctv size={15} /></span>
        <button {...holdProps('right')}><ChevronRight size={22} /></button>
        <span />
        <button {...holdProps('down')}><ChevronDown size={22} /></button>
        <span />
      </div>
      <p className="camera-ptz__hint">按住方向键转动，松手停止</p>
      {error && <p className="camera-ptz__error" role="alert">{error}</p>}
    </div>
  );
}

interface ShotInfo { file: string; time: string }

/** 运动检测截图浏览：打开弹窗时加载，每 10 秒刷新；点击缩略图看大图。 */
function ShotStrip({ cameraId, onSelect }: { cameraId: string; onSelect: (shot: ShotInfo) => void }) {
  const [shots, setShots] = useState<ShotInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(apiPath(`/api/camera-shots?cid=${encodeURIComponent(cameraId)}`));
        if (!response.ok) return;
        const data = await response.json() as { shots?: ShotInfo[] };
        if (alive) setShots(data.shots ?? []);
      } catch {
        // 列表加载失败保持上一次结果。
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [cameraId]);

  return (
    <div className="camera-shots">
      <h4><ImageIcon size={14} />运动检测截图<em>保留 3 天</em></h4>
      {shots.length === 0
        ? <p className="camera-shots__empty">检测到画面移动时会自动截图，目前还没有截图</p>
        : <div className="camera-shots__strip">
            {shots.map((shot) => (
              <button key={shot.file} type="button" className="camera-shots__item" onClick={() => onSelect(shot)} title={shot.time}>
                <img src={apiPath(`/api/camera-shot?cid=${encodeURIComponent(cameraId)}&file=${encodeURIComponent(shot.file)}`)} alt={`运动截图 ${shot.time}`} loading="lazy" />
                <span>{shot.time.slice(5)}</span>
              </button>
            ))}
          </div>}
    </div>
  );
}

/** 运动截图大图。
 * 必须用原生 <dialog showModal>：大画面弹窗本身就是模态 dialog，处于浏览器 top layer，
 * 普通 fixed + z-index 元素永远渲染在它下面（大图压在卡片背后的原因）；嵌套模态 dialog 会自动叠在上层。 */
function ShotViewer({ camera, shot, onClose }: { camera: CameraConfig; shot: ShotInfo; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) openModalQuietly(dialog);
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="camera-shot-viewer"
      onClose={() => { onClose(); releasePointerFocus(); }}
      onCancel={onClose}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
    >
      <button type="button" className="icon-button camera-shot-viewer__close" onClick={onClose} aria-label="关闭截图"><X size={20} /></button>
      <figure>
        <img src={apiPath(`/api/camera-shot?cid=${encodeURIComponent(camera.id)}&file=${encodeURIComponent(shot.file)}`)} alt={`运动截图 ${shot.time}`} />
        <figcaption>{camera.name} · {shot.time}</figcaption>
      </figure>
    </dialog>,
    document.body,
  );
}

/** 大画面弹窗里的 ONVIF 专属区域：云台方向键（设备支持时）+ 运动截图浏览。 */
function OnvifPanel({ camera }: { camera: CameraConfig }) {
  const [ptz, setPtz] = useState<boolean | null>(null);
  const [selected, setSelected] = useState<ShotInfo | null>(null);

  useEffect(() => {
    let alive = true;
    setPtz(null);
    fetch(apiPath(`/api/camera-info?cid=${encodeURIComponent(camera.id)}`))
      .then((response) => response.ok ? response.json() as Promise<{ ptz?: boolean }> : null)
      .then((data) => { if (alive) setPtz(Boolean(data?.ptz)); })
      .catch(() => { if (alive) setPtz(false); });
    return () => { alive = false; };
  }, [camera.id]);

  return (
    <div className="camera-dialog__onvif">
      {ptz && (
        <div className="camera-dialog__ptz">
          <h4>云台控制</h4>
          <PtzPad cameraId={camera.id} />
        </div>
      )}
      <div className="camera-dialog__shots">
        <ShotStrip cameraId={camera.id} onSelect={setSelected} />
      </div>
      {selected && <ShotViewer camera={camera} shot={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** 摄像头大画面弹窗：样式沿用设备详情弹窗，画面更大；关闭即停 ffmpeg。 */
function CameraDialog({ camera, onClose }: { camera: CameraConfig | undefined; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = Boolean(camera);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) openModalQuietly(dialog);
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="device-dialog camera-dialog"
      onClose={() => { onClose(); releasePointerFocus(); }}
      onCancel={onClose}
      onClick={(event) => { if (event.target === dialogRef.current) onClose(); }}
    >
      {camera && <>
        <div className="device-dialog__heading">
          <div><small>摄像头{cameraType(camera) === 'onvif' ? ' · ONVIF' : ''}</small><h2>{camera.name}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭大画面"><X size={20} /></button>
        </div>
        <CameraStream cameraId={camera.id} active={open} fit="contain" />
        {cameraType(camera) === 'onvif' && <OnvifPanel camera={camera} />}
      </>}
    </dialog>,
    document.body,
  );
}

/** 单路摄像头卡片：尺寸等同设备卡“展开”（tile 2×1），点击卡片弹出大画面。 */
function CameraTile({ camera }: { camera: CameraConfig }) {
  const frameRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [open, setOpen] = useState(false);
  // 弹窗打开时由大画面接管取流，卡片预览暂停，避免同一路开两个 ffmpeg。
  const previewActive = visible && pageVisible && !open;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)), { rootMargin: '120px' });
    observer.observe(frame);
    const onVisibility = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <TileFrame
      id={`camera-${camera.id}`}
      label={camera.name}
      size="2x1"
      frameRef={frameRef}
      className="camera-tile-card"
      onOpen={() => setOpen(true)}
    >
      <CameraStream cameraId={camera.id} active={previewActive} fit="cover" />
      <div className="camera-tile-card__caption">
        <Cctv size={14} /><span>{camera.name}</span><i className="camera-tile-card__live" aria-label="实时" />
      </div>
      <CameraDialog camera={open ? camera : undefined} onClose={() => setOpen(false)} />
    </TileFrame>
  );
}

/** 摄像头画面板块：放在首页 / 房间页情景板块的上一行；卡片与设备网格同尺寸；没有摄像头时不渲染。 */
export function CameraBoard({ title, cameras, scale = 1 }: { title: string; cameras: CameraConfig[]; scale?: number }) {
  if (cameras.length === 0) return null;
  return (
    <section className="camera-board">
      <div className="section-heading">
        <h2>{title}</h2>
        <span>点击卡片查看大画面</span>
      </div>
      <AdaptiveGrid className="camera-grid" scale={scale}>
        {cameras.map((camera) => <CameraTile key={camera.id} camera={camera} />)}
      </AdaptiveGrid>
    </section>
  );
}
