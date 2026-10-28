import type { Device } from '../types';

/** 绑定在宿主卡片弹窗里的控制按钮与传感器：开关在前（可点按），只读状态（sensor / binary_sensor）在后。 */
export function BoundGrid({ devices, onToggle }: { devices: Device[]; onToggle: (id: string) => void }) {
  return (
    <div className="climate-detail__group">
      <h3>控制与传感器</h3>
      <div className="bound-grid">
        {[...devices].sort((a, b) => (a.kind === 'switch' ? 0 : 1) - (b.kind === 'switch' ? 0 : 1)).map((device) => device.kind === 'switch'
          ? (
            <button key={device.id} type="button" role="switch" aria-checked={device.on} className={`bound-item bound-item--control${device.on ? ' bound-item--on' : ''}${device.available ? '' : ' bound-item--muted'}`} onClick={() => onToggle(device.id)} disabled={!device.available}>
              <span className="bound-item__name">{device.name}</span>
              <span className="bound-item__switch" aria-hidden="true"><i /></span>
            </button>
          )
          : (
            <div key={device.id} className={`bound-item${device.available ? '' : ' bound-item--muted'}`}>
              <span className="bound-item__name">{device.name}</span>
              <span className="bound-item__value">{device.kind === 'bound' ? device.text : ''}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
