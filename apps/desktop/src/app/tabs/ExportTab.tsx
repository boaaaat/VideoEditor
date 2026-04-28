import { useState } from "react";
import { Ban, Download } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { executeCommand } from "../../features/commands/commandClient";

interface ExportTabProps {
  setStatusMessage: (message: string) => void;
}

export function ExportTab({ setStatusMessage }: ExportTabProps) {
  const [resolution, setResolution] = useState<"1080p" | "1440p" | "4k">("1080p");
  const [fps, setFps] = useState<24 | 25 | 30 | 50 | 60>(30);
  const [bitrate, setBitrate] = useState(20);

  async function exportTimeline() {
    const result = await executeCommand({
      type: "export_timeline",
      outputPath: "exports/output.mp4",
      resolution,
      fps,
      codec: "h264_nvenc",
      bitrateMbps: bitrate
    });

    setStatusMessage(result.ok ? "Export command accepted" : result.error ?? "Export failed");
  }

  return (
    <div className="export-grid">
      <Panel title="MP4 Export">
        <div className="form-grid">
          <label>
            Resolution
            <select value={resolution} onChange={(event) => setResolution(event.target.value as "1080p" | "1440p" | "4k")}>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="4k">4K</option>
            </select>
          </label>
          <label>
            FPS
            <select value={fps} onChange={(event) => setFps(Number(event.target.value) as 24 | 25 | 30 | 50 | 60)}>
              {[24, 25, 30, 50, 60].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Codec
            <input value="H.264 NVENC" readOnly />
          </label>
          <label>
            Audio
            <input value="AAC" readOnly />
          </label>
          <label>
            Bitrate Mbps
            <input type="number" value={bitrate} min={4} max={100} onChange={(event) => setBitrate(Number(event.target.value))} />
          </label>
          <label>
            Output folder
            <input value="project/exports" readOnly />
          </label>
        </div>
        <div className="export-actions">
          <Button icon={<Download size={16} />} variant="primary" onClick={exportTimeline}>
            Export MP4
          </Button>
          <Button icon={<Ban size={16} />}>Cancel</Button>
        </div>
      </Panel>
      <Panel title="Progress">
        <div className="progress-shell">
          <span style={{ width: "0%" }} />
        </div>
        <pre className="log-view">Export logs will appear here.</pre>
      </Panel>
    </div>
  );
}
