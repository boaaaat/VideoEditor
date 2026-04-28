export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: TResult;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcFailure;

export interface EngineStatus {
  appName: string;
  version: string;
  ffmpeg: ToolStatus;
  ffprobe: ToolStatus;
  gpu: GpuStatus;
  previewUrl: string;
}

export interface ToolStatus {
  available: boolean;
  path?: string;
  message?: string;
}

export interface GpuStatus {
  available: boolean;
  name?: string;
  rtx30SeriesOrNewer?: boolean;
  nvencAvailable?: boolean;
  h264NvencAvailable?: boolean;
  hevcNvencAvailable?: boolean;
  av1NvencAvailable?: boolean;
  message?: string;
}
