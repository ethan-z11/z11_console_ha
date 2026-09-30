import { ArrowUpDown, House, Music, Settings } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { PersonStatus } from '../consoleClient';
import { roomIcon } from '../appearance';
import { getRoomActivity } from '../selectors';
import { formatDate, formatTime } from '../time';
import type { HomeState } from '../types';

interface SideNavProps {
  home: HomeState;
  /** 首页入口名称，与首页标题一致。 */
  homeTitle: string;
  /** 当前页面：全屋、设置、音乐或某个房间 id。 */
  current: 'home' | 'settings' | 'music' | { roomId: string };
  now: Date;
  onHome: () => void;
  onOpenRoom: (id: string) => void;
  onSettings: () => void;
  /** 打开房间排序；只读模式下不传，入口隐藏。 */
  onEditRooms?: () => void;
  /** 打开音乐页；未配置音乐地址时不传，入口隐藏。 */
  onOpenMusic?: () => void;
  /** 人员在家状态列表；为空时不显示。 */
  people?: PersonStatus[];
  /** 导航栏品牌名称（默认"家庭控制"）。 */
  brandTitle?: string;
}

/** 左侧导航：全屋在前，房间直接展开；手机上变为可横滑的底部标签栏。 */
export function SideNav({ home, homeTitle, current, now, onHome, onOpenRoom, onSettings, onEditRooms, onOpenMusic, people, brandTitle }: SideNavProps) {
  const navRef = useRef<HTMLElement>(null);
  const currentRoomId = typeof current === 'object' ? current.roomId : null;
  const currentKey = currentRoomId ?? current;
  const groups = [
    { label: '房间', rooms: home.rooms.filter((room) => room.category === 'main') },
    { label: '其他空间', rooms: home.rooms.filter((room) => room.category === 'other') },
  ].filter((group) => group.rooms.length > 0);

  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentKey]);

  return (
    <nav ref={navRef} className="side-nav" aria-label="主导航">
      <div className="side-nav__brand"><span className="brand-mark" aria-hidden="true"><House size={18} /></span><span>{brandTitle ?? '家庭控制'}</span></div>
      <div className="side-nav__items">
        <button type="button" title={homeTitle} aria-current={current === 'home' ? 'page' : undefined} onClick={onHome}><House size={20} /><span>{homeTitle}</span></button>
        {groups.map((group) => (
          <div key={group.label} className="side-nav__group" role="group" aria-label={group.label}>
            <span className="side-nav__label" aria-hidden="true">{group.label}</span>
            {group.rooms.map((room) => {
              const Icon = roomIcon(room);
              const tone = getRoomActivity(home, room.id)[0]?.tone;
              return (
                <button key={room.id} type="button" title={room.name} aria-label={`${room.name}${tone === 'alert' ? '，有告警' : tone ? '，有设备运行' : ''}`} aria-current={currentRoomId === room.id ? 'page' : undefined} onClick={() => onOpenRoom(room.id)}>
                  <Icon size={20} /><span>{room.name}</span>
                  {tone && <i className={`side-nav__dot side-nav__dot--${tone === 'alert' ? 'alert' : 'active'}`} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        ))}
        {onEditRooms && home.rooms.length > 1 && <button type="button" className="side-nav__edit" onClick={onEditRooms} title="调整房间顺序" aria-label="调整房间顺序"><ArrowUpDown size={18} /><span>房间排序</span></button>}
        {onOpenMusic && <button type="button" title="音乐" aria-current={current === 'music' ? 'page' : undefined} onClick={onOpenMusic}><Music size={20} /><span>音乐</span></button>}
      </div>
      <div className="side-nav__footer">
        {people && people.length > 0 && (
          <div className="people-bar">
            {people.map((person) => (
              <div key={person.id} className={`people-avatar ${person.home ? 'people-avatar--home' : 'people-avatar--away'}`} title={`${person.name}：${person.home ? '在家' : '不在家'}`}>
                <img src={person.image} alt={person.name} loading="lazy" />
                {person.home && <span className="people-avatar__badge"><House size={10} /></span>}
              </div>
            ))}
          </div>
        )}
        <div className="side-nav__footer-bottom">
          <div className="side-nav__time">
            <span className="side-nav__clock">{formatTime(now)}</span>
            <span className="side-nav__date">{formatDate(now)}</span>
          </div>
          <button type="button" className="side-nav__settings" onClick={onSettings} aria-current={current === 'settings' ? 'page' : undefined} aria-label="设置" title="设置"><Settings size={18} /></button>
        </div>
      </div>
    </nav>
  );
}
