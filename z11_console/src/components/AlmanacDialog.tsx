import { CalendarDays, Clock3, Compass, Grid3X3, Moon, ScrollText, Sparkles, Sun, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { openModalQuietly, releasePointerFocus } from '../focus';
import type { Almanac } from '../almanac';

function Chips({ items, tone }: { items: string[]; tone?: 'good' | 'bad' | 'plain' }) {
  if (items.length === 0) return <span className="almanac-empty">暂无</span>;
  return (
    <div className="almanac-chips">
      {items.map((item) => <span key={item} className={`almanac-chip${tone ? ` almanac-chip--${tone}` : ''}`}>{item}</span>)}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="almanac-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Moon; title: string; children: ReactNode }) {
  return (
    <section className="almanac-section">
      <h3><Icon size={15} aria-hidden="true" />{title}</h3>
      {children}
    </section>
  );
}

/** 农历/老黄历详情弹窗：点击首页农历副标题打开，参数全部由后端内置历法计算。 */
export function AlmanacDialog({ open, almanac, onClose }: { open: boolean; almanac: Almanac | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) openModalQuietly(dialog);
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const pillarNames = ['年柱', '月柱', '日柱', '时柱'];
  const flyTone: Record<string, string> = { '白': 'almanac-fly--bai', '黑': 'almanac-fly--hei', '碧': 'almanac-fly--bi', '绿': 'almanac-fly--lv', '黄': 'almanac-fly--huang', '赤': 'almanac-fly--chi', '紫': 'almanac-fly--zi' };

  return (
    <dialog ref={dialogRef} className="device-dialog almanac-dialog" aria-label="农历老黄历" onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {open && almanac && <>
        <div className="device-dialog__heading">
          <div><small>中国老黄历</small><h2>农历</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭农历"><X size={20} /></button>
        </div>

        <header className="almanac-hero">
          <p className="almanac-hero__lunar"><CalendarDays size={16} aria-hidden="true" />{almanac.text}</p>
          <p className="almanac-hero__solar">
            {almanac.solarDate} · {almanac.weekday} · 第 {almanac.isoWeek} 周 · {almanac.season}季 · {almanac.starZodiac}
            {almanac.holiday !== '暂无节日' && <span className="almanac-chip almanac-chip--holiday">{almanac.holiday}</span>}
          </p>
          <p className="almanac-hero__term"><Sun size={14} aria-hidden="true" />{almanac.term || '—'} · 下一节气 {almanac.nextTerm}（{almanac.nextTermDate}）</p>
        </header>

        <div className="almanac-layout">
          <Section icon={Sparkles} title="四柱八字">
            <div className="almanac-bazi">
              {almanac.bazi.map((ganzhi, index) => (
                <div key={pillarNames[index]} className="almanac-bazi__pillar">
                  <small>{pillarNames[index]}{index === 0 ? ` · 属${almanac.zodiac}` : ''}</small>
                  <strong>{ganzhi}</strong>
                </div>
              ))}
            </div>
            <dl className="almanac-rows">
              <Row label="纳音五行">{almanac.nayin}</Row>
              <Row label="生肖冲煞">{almanac.zodiacClash}</Row>
              <Row label="星次">{almanac.eastZodiac}</Row>
              <Row label="当前时辰">{almanac.shichen} · {almanac.meridian}当令</Row>
            </dl>
          </Section>

          <Section icon={ScrollText} title="今日宜忌">
            <p className="almanac-level">{almanac.level}</p>
            <dl className="almanac-rows">
              <Row label="宜"><Chips items={almanac.good} tone="good" /></Row>
              <Row label="忌"><Chips items={almanac.bad} tone="bad" /></Row>
              <Row label="彭祖百忌"><Chips items={almanac.pengTaboo} /></Row>
              <Row label="十二神">{almanac.officers12}</Row>
              <Row label="二十八宿">{almanac.stars28}</Row>
            </dl>
          </Section>

          <Section icon={Compass} title="神煞方位">
            <dl className="almanac-rows">
              <Row label="吉神方位"><Chips items={almanac.luckyDirections} /></Row>
              <Row label="今日胎神">{almanac.fetalGod}</Row>
              <Row label="三合六合">{almanac.trines.join('、')} 三合 · {almanac.sixPair} 六合</Row>
              <Row label="六曜">{almanac.sixYao}</Row>
              <Row label="日禄">{almanac.dayLu}</Row>
              <Row label="三十六禽">{almanac.animal36}</Row>
              <Row label="六十四卦">{almanac.gua64}</Row>
              <Row label="吉神宜趋"><Chips items={almanac.goodGods} tone="good" /></Row>
              <Row label="凶煞宜忌"><Chips items={almanac.badGods} tone="bad" /></Row>
            </dl>
          </Section>

          <Section icon={Grid3X3} title="九宫飞星">
            <p className="almanac-fly-center">中宫 · {almanac.flyCenter}</p>
            <div className="almanac-fly">
              {almanac.flyPositions.map((position) => (
                <div key={position.place} className={`almanac-fly__cell ${flyTone[position.color] ?? ''}`}>
                  <small>{position.place}{position.gua ? ` · ${position.gua}宫` : ''}</small>
                  <strong>{position.number}</strong>
                  <span>{position.star}</span>
                </div>
              ))}
            </div>
          </Section>

          <Section icon={Moon} title="月相">
            <dl className="almanac-rows">
              <Row label="月相">{almanac.moon.phase}</Row>
              <Row label="月龄">{almanac.moon.age} 天</Row>
              <Row label="照亮度">{almanac.moon.illumination}%</Row>
              <Row label="夜月">{almanac.moon.nightMoon}</Row>
              <Row label="阴阳 / 五行">{almanac.moon.yinYang} · {almanac.moon.wuxing}</Row>
              <Row label="月事吉凶">{almanac.moon.luck}</Row>
            </dl>
          </Section>

          <Section icon={Clock3} title="十二时辰吉凶">
            <div className="almanac-shichen">
              {almanac.twohourLuck.map((item) => {
                const current = almanac.shichen.startsWith(item.label);
                return (
                  <div key={item.label} className={`almanac-shichen__cell almanac-shichen__cell--${item.value === '吉' ? 'good' : 'bad'}${current ? ' almanac-shichen__cell--current' : ''}`}>
                    <strong>{item.label}</strong>
                    <small>{item.range}</small>
                    <span>{item.value}</span>
                  </div>
                );
              })}
            </div>
          </Section>
        </div>
      </>}
    </dialog>
  );
}
