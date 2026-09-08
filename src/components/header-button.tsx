import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable } from "react-native";

import { colors } from "@/lib/theme";

type Props = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
};

export function HeaderButton({ icon, label, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={12}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingHorizontal: 4 })}
    >
      <Ionicons name={icon} size={24} color={colors.text} />
    </Pressable>
  );
}
