/**
 * 音乐页：以内嵌 iframe 打开设置中配置的音乐地址（如 Navidrome / 音乐面板 / HA 媒体页）。
 * 地址为空时不渲染（侧栏入口也隐藏）。页面标题区不显示，iframe 占满内容区。
 */
export function MusicPage({ url }: { url: string }) {
  return (
    <div className="music-page">
      <iframe className="music-page__frame" src={url} title="音乐" allow="autoplay; encrypted-media; fullscreen" referrerPolicy="no-referrer-when-downgrade" />
    </div>
  );
}
