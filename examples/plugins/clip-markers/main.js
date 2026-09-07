import { markerName } from './labels.js';

export default function run(context) {
  const clips = context.timeline.tracks
    .filter(track => track.kind === 'video' && (track.visible || context.parameters['include-hidden']))
    .flatMap(track => track.clips).sort((a, b) => a.startUs - b.startUs);
  const markers = new Set((context.timeline.markers ?? []).map(marker => marker.id));
  const names = new Map(context.media.map(asset => [asset.id, asset.name]));
  const commands = clips.map((clip, index) => {
    const markerId = `plugin.clip-markers.${clip.id}`;
    return {
      type: markers.has(markerId) ? 'update_marker' : 'add_marker', markerId,
      timeUs: clip.startUs, name: markerName(context.parameters.prefix, index, names.get(clip.mediaId) ?? clip.mediaId), color: '#ffcc66'
    };
  });
  context.log(`Inspected ${clips.length} video clips`);
  return { summary: `Mark the start of ${clips.length} video clips.`, commands };
}
