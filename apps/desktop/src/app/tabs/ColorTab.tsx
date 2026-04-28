import { RotateCcw, Upload } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Slider } from "../../components/Slider";

export function ColorTab() {
  return (
    <div className="tool-grid">
      <Panel title="Basic Adjustment">
        <div className="control-stack">
          <Slider label="Brightness" value={0} min={-100} max={100} step={1} />
          <Slider label="Contrast" value={0} min={-100} max={100} step={1} />
          <Slider label="Saturation" value={100} min={0} max={200} step={1} />
          <Slider label="Temperature" value={0} min={-100} max={100} step={1} />
          <Slider label="Tint" value={0} min={-100} max={100} step={1} />
        </div>
      </Panel>
      <Panel title="LUT">
        <div className="control-stack">
          <Button icon={<Upload size={16} />}>Import LUT</Button>
          <Slider label="Strength" value={100} min={0} max={100} step={1} />
          <Button icon={<RotateCcw size={16} />}>Reset Color</Button>
        </div>
      </Panel>
    </div>
  );
}
