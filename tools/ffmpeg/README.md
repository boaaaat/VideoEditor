# FFmpeg Tools

Development builds look for FFmpeg in this order:

1. `tools/ffmpeg/bin/ffmpeg.exe` and `tools/ffmpeg/bin/ffprobe.exe`
2. `ffmpeg` and `ffprobe` on `PATH`

Do not commit FFmpeg binaries to this repository. Put local downloads in `tools/ffmpeg/bin`.
