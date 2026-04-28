import { Headphones, Mic2, Volume2 } from "lucide-react";
import { Panel } from "../../components/Panel";
import { Slider } from "../../components/Slider";
import { Toggle } from "../../components/Toggle";

export function AudioTab() {
  return (
    <div className="tool-grid">
      <Panel title="Waveform">
        <div className="waveform-preview">
          {Array.from({ length: 48 }).map((_, index) => (
            <span key={index} style={{ height: `${18 + ((index * 17) % 48)}px` }} />
          ))}
        </div>
      </Panel>
      <Panel title="Track Controls">
        <div className="control-stack">
          <Slider label="Volume" value={0} min={-24} max={12} step={1} />
          <Toggle label="Mute" checked={false} />
          <Toggle label="Solo" checked={false} />
        </div>
      </Panel>
      <Panel title="Later">
        <div className="feature-list">
          <span><Headphones size={16} /> Noise reduction</span>
          <span><Mic2 size={16} /> Voice isolation</span>
          <span><Volume2 size={16} /> Auto leveling</span>
        </div>
      </Panel>
    </div>
  );
}
