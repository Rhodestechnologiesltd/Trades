import { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Ionicons } from '@expo/vector-icons';
import { formatDateTime } from '@trades/shared';
import { colors, radius, space } from '@trades/mobile-ui';

export function DateTimeField({ label, value, onChange, minimumDate }: { label: string; value: Date | null; onChange: (d: Date) => void; minimumDate?: Date }) {
  const [mode, setMode] = useState<'date' | 'time' | null>(null);
  return (
    <View style={{ marginBottom: space(4) }}>
      <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: space(1.5) }}>{label}</Text>
      <Pressable onPress={() => setMode('date')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: space(3.5) }}>
        <Ionicons name="calendar-outline" size={18} color={colors.brand} />
        <Text style={{ fontSize: 16, color: value ? colors.text : colors.textFaint }}>{value ? formatDateTime(value.toISOString(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Choose date & time'}</Text>
      </Pressable>
      {mode ? (
        <DateTimePicker
          value={value ?? new Date(Date.now() + 24 * 3600_000)} mode={mode} minimumDate={minimumDate} minuteInterval={15}
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={(e, d) => {
            if (e.type === 'dismissed' || !d) { setMode(null); return; }
            onChange(d);
            setMode(mode === 'date' && Platform.OS === 'android' ? 'time' : Platform.OS === 'ios' ? mode : null);
          }}
        />
      ) : null}
      {mode && Platform.OS === 'ios' ? (
        <Pressable onPress={() => setMode(mode === 'date' ? 'time' : null)} style={{ alignSelf: 'flex-end', padding: 8 }}>
          <Text style={{ color: colors.brand, fontWeight: '600' }}>{mode === 'date' ? 'Next: time' : 'Done'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
