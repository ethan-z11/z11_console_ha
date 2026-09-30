import { Pause, Play, Power, Speaker, Tv, Volume2 } from 'lucide-react';
import type { MediaDevice, Room } from '../types';
import { TileFrame } from './TileFrame';
import type { TileLayoutProps } from './TileFrame';

interface MediaPlayerCardProps {
  layout: TileLayoutProps;
  media: MediaDevice;
  room: Room;
  onPower: (id: string) => void;
  onPlayPause: (id: string) => void;
  onVolume: (id: string, volume: number) => void;
}

const statusLabels: Record<MediaDevice['status'], string> = { off: '已关闭', idle: '待机', playing: '播放中', paused: '已暂停', unknown: '状态未知' };

export function MediaPlayerCard({ layout, media, room, onPower, onPlayPause, onVolume }: MediaPlayerCardProps) {
  const { editing } = layout;
  const Icon = media.mediaType === 'speaker' ? Speaker : Tv;
  const label = `${room.name}${media.name}`;
  const status = media.available ? statusLabels[media.status] : '设备不可用';
  const playing = media.status === 'playing';
  const controlsDisabled = !media.available || editing || media.status === 'off';

  return (
    <TileFrame {...layout} className="media-card" active={playing}>
      <div className="media-card__header">
        <span className="media-card__icon"><Icon size={21} /></span>
        <div className="media-card__identity"><span className="tile__room tile__room--inline" aria-hidden="true">{room.name}</span><span className="tile__name">{media.name}</span><span className="tile__note">{status}</span></div>
        <span className="tile__room">{room.name}</span>
      </div>
      <div className="media-card__footer">
        <span className="media-card__detail">{media.detail || (playing ? '正在播放' : '暂无播放内容')}</span>
        <div className="media-card__actions">
          {media.canPower && <button type="button" onClick={() => onPower(media.id)} disabled={!media.available || editing} aria-label={`${media.status === 'off' ? '打开' : '关闭'}${label}`} aria-pressed={media.status !== 'off'}><Power size={18} /></button>}
          {media.canPlayPause && <button type="button" className="media-card__play" onClick={() => onPlayPause(media.id)} disabled={controlsDisabled} aria-label={`${playing ? '暂停' : '播放'}${label}`}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>}
        </div>
      </div>
      {media.volume !== undefined && (
        <div className="media-card__volume">
          <Volume2 size={16} />
          <input type="range" min="0" max="100" value={media.volume} onChange={(event) => onVolume(media.id, Number(event.target.value))} disabled={controlsDisabled} aria-label={`调整${label}音量`} />
          <output>{media.volume}%</output>
        </div>
      )}
    </TileFrame>
  );
}
