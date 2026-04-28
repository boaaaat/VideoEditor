import { Move, RotateCw, Scan, SlidersHorizontal } from "lucide-react";
import { Panel } from "../../components/Panel";
import { Slider } from "../../components/Slider";

export function EffectsTab() {
  return (
    <div className="tool-grid">
      <Panel title="Transform">
        <div className="control-stack">
          <Slider label="Scale" value={100} min={10} max={400} step={1} />
          <Slider label="Position X" value={0} min={-2000} max={2000} step={1} />
          <Slider label="Position Y" value={0} min={-2000} max={2000} step={1} />
          <Slider label="Rotation" value={0} min={-180} max={180} step={1} />
          <Slider label="Opacity" value={100} min={0} max={100} step={1} />
        </div>
      </Panel>
      <Panel title="Later Effects">
        <div className="feature-list">
          <span><Scan size={16} /> Blur and sharpen</span>
          <span><Move size={16} /> Motion effects</span>
          <span><RotateCw size={16} /> Transitions</span>
          <span><SlidersHorizontal size={16} /> Green screen</span>
        </div>
      </Panel>
    </div>
  );
}
