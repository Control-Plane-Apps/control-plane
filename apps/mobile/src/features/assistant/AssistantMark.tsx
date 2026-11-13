import { View } from "react-native";

// Fork-owned. The Assistant's mark: a clay ring, drawn from the primary token
// so it follows the theme.

export function AssistantMark(props: { readonly size?: number }) {
  // The ring is 19/24 of the icon box, its stroke 5.5/24, like the design's glyph.
  const box = props.size ?? 15;
  const diameter = Math.round((box * 19) / 24);
  const stroke = Math.max(2, Math.round(((box * 5.5) / 24) * 2) / 2);
  return (
    <View
      accessible={false}
      className="items-center justify-center"
      style={{ width: box, height: box }}
    >
      <View
        className="rounded-full border-primary"
        style={{ width: diameter, height: diameter, borderWidth: stroke }}
      />
    </View>
  );
}
