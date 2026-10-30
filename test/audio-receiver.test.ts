// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AudioReceiver } from "../src/client/audio/AudioReceiver";

/** A microphone whose permission prompt the test answers by hand. */
function fakeMicrophone() {
  const pending: Array<(stream: MediaStream) => void> = [];
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        pending.push(resolve);
      }),
  );
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });

  const grant = () => {
    const track = { stop: vi.fn() };
    tracks.push(track);
    pending.shift()?.({ getTracks: () => [track] } as unknown as MediaStream);
  };
  const live = () => tracks.filter((t) => t.stop.mock.calls.length === 0).length;
  return { getUserMedia, grant, live };
}

beforeAll(() => {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  class FakeContext {
    state = "running";
    sampleRate = 48000;
    destination = {};
    createMediaStreamSource = node;
    createScriptProcessor = node;
    resume = () => Promise.resolve();
  }
  (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeContext;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("AudioReceiver", () => {
  it("opens one microphone for two quick clicks", async () => {
    const mic = fakeMicrophone();
    const receiver = new AudioReceiver();
    const first = receiver.start();
    const second = receiver.start();
    await tick();
    mic.grant();
    await Promise.all([first, second]);
    expect(mic.getUserMedia).toHaveBeenCalledOnce();
    receiver.stop();
    expect(mic.live()).toBe(0);
  });

  it("closes a microphone that opens after stop()", async () => {
    const mic = fakeMicrophone();
    const receiver = new AudioReceiver();
    const starting = receiver.start();
    await tick();
    receiver.stop();
    mic.grant();
    await starting;
    expect(mic.live()).toBe(0);
    expect(receiver.state).toBe("idle");
  });

  it("records nothing when push-to-talk is released before the microphone opens", async () => {
    const mic = fakeMicrophone();
    const receiver = new AudioReceiver({ pushToTalk: true });
    const pressing = receiver.press();
    await tick();
    receiver.release();
    mic.grant();
    await pressing;
    expect(receiver.isRecording).toBe(false);
    receiver.stop();
  });
});
