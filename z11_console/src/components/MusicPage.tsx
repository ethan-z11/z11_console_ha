import { ExternalLink, Music } from 'lucide-react';

/**
 * 音乐页：以内嵌 iframe 打开设置中配置的音乐地址（如 Navidrome / 音乐面板 / HA 媒体页）。
 * 地址为空时不渲染（侧栏入口也隐藏）；部分站点会用 X-Frame-Options 禁止内嵌，提供“在新标签打开”兜底。
 */
export function MusicPage({ url }: { url: string }) {
  return (
    <div className="music-page">
      <div className="music-page__bar">
        <span className="music-page__title"><Music size={16} />音乐</span>
        <a className="small-button" href={url} target="_blank" rel="noreferrer noopener"><ExternalLink size={15} />新标签打开</a>
      </div>
      <iframe className="music-page__frame" src={url} title="音乐" allow="autoplay; encrypted-media; fullscreen" referrerPolicy="no-referrer-when-downgrade" />
    </div>
  );
}
