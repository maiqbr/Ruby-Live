export type MediaKind = 'screen' | 'camera';

export type CameraQuality = 360 | 480 | 720 | 1080;
export type CameraFps = 15 | 30 | 60;

type ScreenSendParameters = RTCRtpSendParameters & {
  degradationPreference?: 'maintain-framerate' | 'maintain-resolution' | 'balanced';
  encodings: Array<RTCRtpEncodingParameters & { priority?: 'very-low' | 'low' | 'medium' | 'high' }>;
};

export function prepareScreenTrack(track: MediaStreamTrack) {
  if (track.kind === 'video' && 'contentHint' in track) track.contentHint = 'detail';
}

async function preferScreenDetail(sender: RTCRtpSender) {
  try {
    const parameters = sender.getParameters() as ScreenSendParameters;
    parameters.degradationPreference = 'maintain-resolution';
    for (const encoding of parameters.encodings || []) encoding.priority = 'high';
    await sender.setParameters(parameters);
  } catch {
    // Browsers may expose only part of the optional WebRTC quality controls.
  }
}

export function cameraVideoConstraints(quality: CameraQuality = 360, fps: CameraFps = 15): MediaTrackConstraints {
  const width = { 360: 640, 480: 640, 720: 1280, 1080: 1920 }[quality];
  return {
    width: { ideal: width, max: width },
    height: { ideal: quality, max: quality },
    frameRate: { ideal: fps, max: fps },
  };
}

export function exactCameraVideoConstraints(quality: CameraQuality, fps: CameraFps): MediaTrackConstraints {
  const width = { 360: 640, 480: 640, 720: 1280, 1080: 1920 }[quality];
  return {
    width: { exact: width },
    height: { exact: quality },
    frameRate: { ideal: fps, max: fps },
  };
}

export function cameraConstraints(deviceId: string, quality: CameraQuality = 360, fps: CameraFps = 15): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      ...cameraVideoConstraints(quality, fps),
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    },
  };
}

// Each media kind has its own peer connection; never touch the other source.
export function syncOutgoingTracks(pc: RTCPeerConnection, stream: MediaStream | null, subscribed: boolean) {
  const wanted = subscribed && stream ? stream.getTracks().filter(track => track.readyState === 'live') : [];
  const ids = new Set(wanted.map(track => track.id));
  for (const sender of pc.getSenders()) {
    if (sender.track && !ids.has(sender.track.id)) pc.removeTrack(sender);
  }
  const sent = new Set(pc.getSenders().map(sender => sender.track?.id));
  for (const track of wanted) {
    if (sent.has(track.id)) continue;
    const sender = pc.addTrack(track, stream!);
    if (track.kind === 'video' && track.contentHint === 'detail') void preferScreenDetail(sender);
  }
}
