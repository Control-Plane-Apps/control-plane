import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { AssistantMark } from "./AssistantMark";

// Fork-owned. The iPhone Assistant's centered header title: the mark and "Assistant".
export function AssistantHeaderTitle() {
  return (
    <View accessibilityLabel="Assistant" accessible className="flex-row items-center gap-[5px]">
      <AssistantMark size={15} />
      <Text className="text-[17px] font-t3-semibold text-foreground">Assistant</Text>
    </View>
  );
}
