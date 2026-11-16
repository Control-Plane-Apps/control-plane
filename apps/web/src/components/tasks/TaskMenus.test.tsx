import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/menu", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return {
    Menu: Wrapper,
    MenuGroup: Wrapper,
    MenuItem: Wrapper,
    MenuPopup: Wrapper,
    MenuSeparator: () => null,
    MenuTrigger: Wrapper,
  };
});
const { TaskReminderMenu } = await import("./TaskMenus");
let renderer: ReactTestRenderer;
afterEach(() => act(() => renderer.unmount()));
async function mount() {
  const onChange = vi.fn();
  await act(async () => {
    renderer = create(
      <TaskReminderMenu time="09:00" onChange={onChange} formatTime={(time) => time}>
        Remind
      </TaskReminderMenu>,
    );
  });
  return { input: renderer.root.findByProps({ "aria-label": "Reminder time" }), onChange };
}
function key(key: string) {
  return { key, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}
describe("custom reminder keyboard", () => {
  it("keeps changes as a draft until Enter, without a duplicate blur write", async () => {
    const { input, onChange } = await mount();
    await act(async () => input.props.onChange({ target: { value: "15:30" } }));
    expect(onChange).not.toHaveBeenCalled();
    act(() => input.props.onKeyDown(key("Enter")));
    act(() => input.props.onBlur());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("15:30");
  });
  it("applies a changed draft on blur", async () => {
    const { input, onChange } = await mount();
    await act(async () => input.props.onChange({ target: { value: "12:00" } }));
    act(() => input.props.onBlur());
    expect(onChange).toHaveBeenCalledExactlyOnceWith("12:00");
  });
  it("cancels Escape without applying the draft on blur", async () => {
    const { input, onChange } = await mount();
    await act(async () => input.props.onChange({ target: { value: "12:00" } }));
    await act(async () => input.props.onKeyDown(key("Escape")));
    act(() => input.props.onBlur());
    expect(onChange).not.toHaveBeenCalled();
    expect(input.props.value).toBe("09:00");
  });
});
