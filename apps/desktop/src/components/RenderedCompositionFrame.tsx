import { useEffect, useMemo, useState } from "react";
import { getCompositionFrame, type CompositionFrame, type CompositionFrameInput } from "../features/playback/composition";

export interface CompositionRenderStatus { state: "rendering" | "ready" | "error"; error?: string }
export function RenderedCompositionFrame({onStatus, ...props}: CompositionFrameInput & {onStatus: (status: CompositionRenderStatus) => void}) {
  const [result, setResult] = useState<{key:string; frame?:CompositionFrame; error?:string} | null>(null);
  const key = useMemo(() => JSON.stringify(props), [props.timeline, props.mediaAssets, props.projectSettings, props.projectPath, props.timeUs, props.maxWidth]);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void getCompositionFrame(JSON.parse(key) as CompositionFrameInput, controller.signal)
        .then((frame) => {if (!controller.signal.aborted) setResult({key,frame});})
        .catch((error) => {if (!controller.signal.aborted) setResult({key,error:error instanceof Error ? error.message : String(error)});});
    }, 90);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [key]);
  const current = result?.key === key ? result : null;
  useEffect(() => { onStatus({state: current?.frame ? "ready" : current?.error ? "error" : "rendering",error:current?.error}); }, [current, onStatus]);
  return current?.frame ? <img className="rendered-composition-frame" src={current.frame.dataUrl} alt="Rendered timeline composition" draggable={false} data-frame-time-us={current.frame.timeUs} onError={() => setResult({key,error:"The rendered image could not be displayed"})} /> : null;
}
