import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scheduleConnectionStatus, startConnectionStatusGrace } from "./connection-status-grace";

afterEach(() => vi.useRealTimers());

describe("connection notice grace period", () => {
  it("waits five seconds before surfacing a persistent interruption", () => {
    vi.useFakeTimers();
    const show = vi.fn();
    scheduleConnectionStatus(show);
    vi.advanceTimersByTime(4_999);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
  });

  it("cancels on recovery and gives the next interruption a fresh grace period", () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const cancel = scheduleConnectionStatus(show);
    vi.advanceTimersByTime(3_000);
    cancel();
    scheduleConnectionStatus(show);
    vi.advanceTimersByTime(4_999);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledOnce();
  });
});

describe("foreground interruption lifecycle", () => {
  it("shows phone offline immediately without waiting", () => {
    vi.useFakeTimers();
    const show = vi.fn();
    startConnectionStatusGrace({ pending: true, offline: true, active: true, show });
    expect(show).toHaveBeenLastCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh grace period after backgrounding or changing environment", () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const dispose = startConnectionStatusGrace({
      pending: true,
      offline: false,
      active: true,
      show,
    });
    vi.advanceTimersByTime(3_000);
    dispose();
    startConnectionStatusGrace({ pending: true, offline: false, active: false, show });
    vi.advanceTimersByTime(10_000);
    expect(show).not.toHaveBeenCalledWith(true);
    startConnectionStatusGrace({ pending: true, offline: false, active: true, show });
    vi.advanceTimersByTime(4_999);
    expect(show).not.toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenLastCalledWith(true);
  });

  it("clears the notice immediately after recovery", () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const dispose = startConnectionStatusGrace({
      pending: true,
      offline: false,
      active: true,
      show,
    });
    vi.advanceTimersByTime(5_000);
    expect(show).toHaveBeenLastCalledWith(true);
    dispose();
    startConnectionStatusGrace({ pending: false, offline: false, active: true, show });
    expect(show).toHaveBeenLastCalledWith(false);
  });
});
