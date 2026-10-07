import { Droplets, Eye, Gauge, LocateFixed, MapPin, RefreshCw, Search, Sun, Umbrella, Wind, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { openModalQuietly, releasePointerFocus } from '../focus';
import type { WeatherState } from '../useWeather';
import { clockOf, dayLabel, placeDetail, searchPlaces, uvLevel, weatherIcon } from '../weather';
import type { Forecast, WeatherPlace } from '../weather';

function PlacePicker({ weather }: { weather: WeatherState }) {
  const { place, choosePlace, locate, locating, locateError } = weather;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WeatherPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const listId = useId();
  const trimmed = query.trim();

  // 输入停顿 350ms 后再搜索，服务端另有 1 天缓存。
  useEffect(() => {
    if (!trimmed) {
      setResults([]);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      searchPlaces(trimmed)
        .then((places) => { if (!cancelled) { setResults(places); setSearchError(places.length ? null : '没有找到该地点'); } })
        .catch((reason: Error) => { if (!cancelled) { setResults([]); setSearchError(reason.message); } })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [trimmed]);

  function pick(next: WeatherPlace) {
    choosePlace(next);
    setQuery('');
  }

  return (
    <section className="weather-place" aria-label="位置">
      <div className="weather-place__current">
        <span className="tile__chip"><MapPin size={20} /></span>
        <div>
          <strong>{place?.name ?? '未选择位置'}</strong>
          <span>{place ? placeDetail(place) || place.country : '搜索城市或区县，或使用当前位置'}</span>
        </div>
      </div>
      <div className="weather-place__tools">
        <div className="weather-search">
          <label className="weather-search__field">
            <Search size={17} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && results[0]) { event.preventDefault(); pick(results[0]); }
                if (event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); }
              }}
              placeholder="搜索城市、区县，如 西湖区"
              aria-label="搜索地点"
              aria-controls={trimmed ? listId : undefined}
              aria-expanded={Boolean(trimmed)}
              role="combobox"
              maxLength={40}
            />
          </label>
          {trimmed && (
            <div className="weather-results" id={listId} role="listbox" aria-label="搜索结果">
              {results.map((result) => (
                <button key={result.id} type="button" role="option" aria-selected="false" onClick={() => pick(result)}>
                  <strong>{result.name}</strong>
                  <span>{[placeDetail(result), result.country !== '中国' ? result.country : ''].filter(Boolean).join(' · ')}</span>
                </button>
              ))}
              {(searching || searchError) && results.length === 0 && <p>{searching ? '正在搜索…' : searchError}</p>}
            </div>
          )}
        </div>
        <button type="button" className="small-button" onClick={locate} disabled={locating}>
          <LocateFixed size={15} />{locating ? '定位中…' : '使用当前位置'}
        </button>
      </div>
      {locateError && <p className="weather-place__error" role="alert">{locateError}</p>}
    </section>
  );
}

function NowCard({ forecast }: { forecast: Forecast }) {
  const { now } = forecast;
  const today = forecast.daily[0];
  const { Icon, tone } = weatherIcon(now.icon);
  const metrics = [
    { icon: Droplets, label: '湿度', value: `${now.humidity}%` },
    { icon: Wind, label: '风', value: `${now.windDir} ${now.windScale} 级` },
    { icon: Umbrella, label: '降水', value: `${now.precip} mm` },
    { icon: Gauge, label: '气压', value: `${now.pressure} hPa` },
    { icon: Eye, label: '能见度', value: `${now.vis} km` },
    ...(today ? [{ icon: Sun, label: '紫外线', value: `${today.uvIndex} ${uvLevel(today.uvIndex)}` }] : []),
  ];
  return (
    <section className={`weather-now weather--${tone}`} aria-label="实时天气">
      <div className="weather-now__main">
        <span className="weather-now__icon"><Icon size={58} strokeWidth={1.4} /></span>
        <div>
          <strong className="weather-now__temp">{now.temp}<small>°</small></strong>
          <span className="weather-now__text">{now.text}</span>
          <span className="weather-now__range">{today && `${today.tempMin}° / ${today.tempMax}°`}</span>
        </div>
      </div>
      <dl className="weather-now__metrics">
        {metrics.map(({ icon: MetricIcon, label, value }) => (
          <div key={label}><dt><MetricIcon size={14} aria-hidden="true" />{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
      <p className="weather-now__meta">观测于 {clockOf(now.obsTime)}{today && ` · 日出 ${today.sunrise} · 日落 ${today.sunset}`}</p>
    </section>
  );
}

function WeekCard({ forecast, now }: { forecast: Forecast; now: Date }) {
  const weekMin = Math.min(...forecast.daily.map((day) => Number(day.tempMin)));
  const span = Math.max(...forecast.daily.map((day) => Number(day.tempMax))) - weekMin || 1;
  return (
    <section className="weather-week" aria-label="未来 7 天">
      <h3>未来 7 天</h3>
      <ol>
        {forecast.daily.map((day) => {
          const label = dayLabel(day.fxDate, now);
          const { Icon, tone } = weatherIcon(day.iconDay);
          const text = day.textDay === day.textNight ? day.textDay : `${day.textDay}转${day.textNight}`;
          const left = ((Number(day.tempMin) - weekMin) / span) * 100;
          const width = ((Number(day.tempMax) - Number(day.tempMin)) / span) * 100;
          return (
            <li key={day.fxDate} className="weather-day">
              <span className="weather-day__name"><strong>{label.name}</strong><small>{label.date}</small></span>
              <span className={`weather-day__icon weather--${tone}`}><Icon size={22} /></span>
              <span className="weather-day__text">{text}{Number(day.precip) > 0 && <small>降水 {day.precip} mm</small>}</span>
              <span className="weather-day__temps" aria-label={`最低 ${day.tempMin}°，最高 ${day.tempMax}°`}>
                <span className="weather-day__min">{day.tempMin}°</span>
                <span className="weather-day__bar" aria-hidden="true"><i style={{ left: `${left}%`, width: `${Math.max(width, 4)}%` }} /></span>
                <span className="weather-day__max">{day.tempMax}°</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 天气详情弹窗：切换位置（搜索或定位）、实时天气、未来 7 天。 */
export function WeatherDialog({ open, weather, now, onClose }: { open: boolean; weather: WeatherState; now: Date; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { place, forecast, loading, error, refresh } = weather;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) openModalQuietly(dialog);
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={dialogRef} className="device-dialog weather-dialog" aria-label="天气" onClose={() => { onClose(); releasePointerFocus(); }} onCancel={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {open && <>
        <div className="device-dialog__heading">
          <div><small>中国天气网</small><h2>天气</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭天气"><X size={20} /></button>
        </div>
        <PlacePicker weather={weather} />
        {!place ? (
          <div className="empty-room"><span className="tile__chip"><MapPin size={20} /></span><p>还没有选择位置。搜索城市或区县，或点“使用当前位置”。</p></div>
        ) : !forecast ? (
          <div className="empty-room">
            <span className="tile__chip"><RefreshCw size={20} className={loading ? 'spin' : undefined} /></span>
            <p>{error && !loading ? `获取天气失败：${error}` : '正在获取天气…'}</p>
            {error && !loading && <button type="button" className="small-button" onClick={refresh}>重试</button>}
          </div>
        ) : (
          <>
            <div className="weather-layout">
              <NowCard forecast={forecast} />
              <WeekCard forecast={forecast} now={now} />
            </div>
            <p className="weather-source">
              数据来源：中国天气网 · 更新于 {clockOf(forecast.updateTime)}
              {error && ` · 刷新失败：${error}`}
              {forecast.fxLink && <> · <a href={forecast.fxLink} target="_blank" rel="noreferrer">查看详情</a></>}
              <button type="button" className="weather-source__refresh" onClick={refresh} disabled={loading} aria-label="刷新天气" title="刷新">
                <RefreshCw size={14} className={loading ? 'spin' : undefined} />
              </button>
            </p>
          </>
        )}
      </>}
    </dialog>
  );
}

/** 小屏幕：放在首页标题同一行右侧的紧凑天气，只显示图标、温度、天气与地点，点击打开详情弹窗。 */
export function WeatherCompact({ weather, onOpen }: { weather: WeatherState; onOpen: () => void }) {
  const { place, forecast } = weather;
  if (!place || !forecast) return null;
  const { Icon, tone } = weatherIcon(forecast.now.icon);
  return (
    <button type="button" className={`weather-compact weather--${tone}`} onClick={onOpen} aria-label={`${place.name}：${forecast.now.text}，${forecast.now.temp}°，查看天气详情`}>
      <Icon className="weather-compact__icon" size={30} strokeWidth={1.6} aria-hidden="true" />
      <span>
        <strong>{forecast.now.temp}<small>°</small></strong>
        <small>{forecast.now.text} · {place.name}</small>
      </span>
    </button>
  );
}

/** 首页顶部右侧的天气：当前天气与接下来几天，点击打开详情弹窗。背景色调由页头按天气设置。 */
export function WeatherHero({ weather, now, onOpen }: { weather: WeatherState; now: Date; onOpen: () => void }) {
  const { place, forecast, loading, error } = weather;

  if (!place || !forecast) {
    const text = !place ? '选择位置以显示天气' : loading ? '正在获取天气…' : error ? `天气暂不可用：${error}` : '正在获取天气…';
    return (
      <button type="button" className="weather-hero weather-hero--empty" onClick={onOpen}>
        <MapPin size={16} aria-hidden="true" /><span>{text}</span>
      </button>
    );
  }

  const { now: current } = forecast;
  const today = forecast.daily[0];
  const { Icon } = weatherIcon(current.icon);
  const detail = placeDetail(place);
  return (
    <button type="button" className="weather-hero" onClick={onOpen} aria-label={`${place.name}：${current.text}，${current.temp}°，查看天气详情`}>
      <Icon className="weather-hero__backdrop" size={210} strokeWidth={0.9} aria-hidden="true" />
      <span className="weather-hero__place"><MapPin size={14} aria-hidden="true" />{place.name}{detail && <small>{detail.split(' · ')[0]}</small>}</span>
      <span className="weather-hero__body">
      <span className="weather-hero__now">
        <span className="weather-hero__reading">
          <Icon className="weather-hero__icon" size={44} strokeWidth={1.5} aria-hidden="true" />
          <strong>{current.temp}<small>°</small></strong>
        </span>
        <span className="weather-hero__text">{current.text}{today && ` · ${today.tempMin}° / ${today.tempMax}°`}</span>
        <span className="weather-hero__meta">湿度 {current.humidity}% · {current.windDir} {current.windScale} 级</span>
      </span>
      <span className="weather-hero__days" aria-hidden="true">
        {forecast.daily.slice(1, 6).map((day) => {
          const { Icon: DayIcon, tone } = weatherIcon(day.iconDay);
          return (
            <span key={day.fxDate} className="weather-hero__day">
              <small>{dayLabel(day.fxDate, now).name}</small>
              <DayIcon className={`weather--${tone}`} size={22} strokeWidth={1.7} />
              <strong>{day.tempMax}°</strong>
              <span>{day.tempMin}°</span>
            </span>
          );
        })}
      </span>
      </span>
    </button>
  );
}
