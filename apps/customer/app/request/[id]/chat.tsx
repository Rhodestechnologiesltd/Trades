import { useState } from 'react';
import { FlatList, Text, TextInput, View, Pressable, KeyboardAvoidingView, Platform } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@trades/shared';
import { Muted, colors, radius, space, useApi, useSession } from '@trades/mobile-ui';

export default function Chat() {
  const { id, providerId, name } = useLocalSearchParams<{ id: string; providerId?: string; name?: string }>();
  const api = useApi();
  const { me } = useSession();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const thread = useQuery({ queryKey: ['chat', id, providerId], queryFn: () => api.requests.messages(id, providerId), refetchInterval: 8000 });

  async function send() {
    const body = text.trim();
    if (!body) return;
    setText('');
    await api.requests.sendMessage(id, body, providerId);
    qc.invalidateQueries({ queryKey: ['chat', id] });
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: name ?? 'Messages' }} />
      <FlatList
        data={thread.data ?? []} keyExtractor={m => m.id} contentContainerStyle={{ padding: space(4) }}
        ListHeaderComponent={<Muted center>Keep payments and contact on Trades — phone numbers are hidden until you book, so you stay protected.</Muted>}
        renderItem={({ item }) => {
          const mine = item.sender_user_id === me?.id;
          return (
            <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '80%', marginTop: space(2) }}>
              <View style={{ backgroundColor: mine ? colors.brand : colors.surface, padding: space(3), borderRadius: radius.lg }}>
                <Text style={{ color: mine ? '#fff' : colors.text, fontSize: 15 }}>{item.body}</Text>
              </View>
              <Text style={{ fontSize: 11, color: colors.textFaint, marginTop: 2, alignSelf: mine ? 'flex-end' : 'flex-start' }}>{formatDateTime(item.created_at, { timeStyle: 'short' })}</Text>
            </View>
          );
        }}
      />
      <View style={{ flexDirection: 'row', padding: space(3), gap: space(2), backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
        <TextInput value={text} onChangeText={setText} placeholder="Write a message" style={{ flex: 1, backgroundColor: colors.bg, borderRadius: radius.pill, paddingHorizontal: 16, fontSize: 15, minHeight: 44 }} maxLength={2000} />
        <Pressable onPress={send} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Send">
          <Ionicons name="send" size={18} color="#fff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
