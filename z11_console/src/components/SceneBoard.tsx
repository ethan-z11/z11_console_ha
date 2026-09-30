import { Loader2 } from 'lucide-react';
import type { CatalogueEntity, CustomConfig } from '../consoleClient';
import { findSceneIcon } from '../icons';
import { sceneDisplayName } from '../haAdapter';

type SceneButton = CustomConfig['scenes'][number];

interface SceneBoardProps {
  title: string;
  scenes: SceneButton[];
  /** 已发现的实体，用于按钮未命名时回退显示实体名称。 */
  entities: Pick<CatalogueEntity, 'id' | 'name'>[];
  /** 正在执行的情景 id，对应按钮转圈并禁用，防止重复点击。 */
  pendingId: string | null;
  onRun: (scene: SceneButton) => void;
}

/** 情景模式板块：一排可换行的大按钮，点击触发设置中指向的实体。没有按钮时板块由调用方隐藏。 */
export function SceneBoard({ title, scenes, entities, pendingId, onRun }: SceneBoardProps) {
  return (
    <section className="scene-board">
      <div className="section-heading">
        <h2>{title}</h2>
      </div>
      <div className="scene-board__buttons">
        {scenes.map((scene) => {
          const pending = pendingId === scene.id;
          const Icon = pending ? Loader2 : findSceneIcon(scene.icon);
          const label = sceneDisplayName(scene, entities);
          // 卡片按 4 个中文字的宽度对齐；超过 4 字时按比例缩小字号，保证所有卡片宽度一致。
          const len = Array.from(label).length;
          const fontScale = len > 4 ? 4 / len : 1;
          return (
            <button key={scene.id} type="button" className="scene-button" onClick={() => onRun(scene)} disabled={pending} aria-busy={pending} style={{ '--scene-font-scale': fontScale } as React.CSSProperties}>
              <Icon size={17} className={pending ? 'spin' : undefined} aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
