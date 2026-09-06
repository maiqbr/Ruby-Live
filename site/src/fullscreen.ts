type IOSVideoElement = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

export async function openMediaFullscreen(container: HTMLElement | null, video: HTMLVideoElement | null) {
  if (container?.requestFullscreen) {
    try {
      await container.requestFullscreen();
      return true;
    } catch {
      // Mobile Safari only exposes fullscreen on the video element.
    }
  }

  const iosVideo = video as IOSVideoElement | null;
  if (iosVideo?.webkitEnterFullscreen) {
    try {
      iosVideo.webkitEnterFullscreen();
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
