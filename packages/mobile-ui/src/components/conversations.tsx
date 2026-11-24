import { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useHeaderHeight } from '@react-navigation/elements';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatDateTime, timeAgo } from '@trades/shared';
import { useApi, useSession } from '../session';
import { colors, radius, space } from '../theme';
import { Banner, Button, EmptyState, Loading, Muted, Screen } from './primitives';

export function Conversations() {
  const api = useApi();
  const conversations = useQuery({ queryKey: ['conversations'], queryFn: () => api.conversations.list(), refetchInterval: 8000 });
  if (conversations.isLoading) return <Loading />;
  return <Screen refreshing={conversations.isRefetching} onRefresh={() => { void conversations.refetch(); }}>
    {conversations.isError ? <Banner tone="danger" title="Could not load conversations" body="Pull down to try again." /> : null}
    {conversations.isSuccess && !conversations.data?.length ? <EmptyState icon="chatbubbles-outline" title="No conversations yet" body="Messages with your pros or customers will appear here." /> : null}
    {conversations.data?.map(conversation => <Pressable key={conversation.userId}
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/chat/[userId]', params: { userId: conversation.userId, name: conversation.name } } as any)}
      style={{ padding: space(4), backgroundColor: conversation.unreadCount ? colors.brandSoft : colors.surface, borderRadius: radius.md, marginBottom: space(2) }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
        <Text style={{ flex: 1, fontWeight: '700', color: colors.text }}>{conversation.name || 'Conversation'}</Text>
        <Muted>{timeAgo(conversation.updatedAt)}</Muted>
      </View>
      <Muted>{conversation.requestTitle}</Muted>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <Text numberOfLines={2} style={{ flex: 1, color: colors.textMuted }}>{conversation.preview}</Text>
        {conversation.unreadCount > 0 ? <Text accessibilityLabel={conversation.unreadCount + ' unread messages'} style={{ color: colors.brand, fontWeight: '700' }}>{conversation.unreadCount}</Text> : null}
      </View>
    </Pressable>)}
  </Screen>;
}

export function Conversation() {
  const { userId, name } = useLocalSearchParams<{ userId: string; name?: string }>();
  const api = useApi();
  const { me } = useSession();
  const qc = useQueryClient();
  const headerHeight = useHeaderHeight();
  const focused = useIsFocused();
  const [text, setText] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [choosingJob, setChoosingJob] = useState(false);
  const thread = useInfiniteQuery({
    queryKey: ['conversation', userId], initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const page = await api.conversations.messages(userId, pageParam);
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      return page;
    },
    getNextPageParam: page => page.nextCursor ?? undefined, enabled: focused, refetchInterval: focused ? 8000 : false,
  });
  const first = thread.data?.pages[0];
  const requests = first?.requests ?? [];
  const selected = requests.find(request => request.id === requestId) ?? requests.find(request => request.id === first?.items[0]?.requestId) ?? requests[0];
  const messages = thread.data?.pages.flatMap(page => page.items) ?? [];
  const send = useMutation({
    mutationFn: ({ body, jobId }: { body: string; jobId: string }) => api.requests.sendMessage(jobId, body, me?.user_type === 'customer' ? userId : undefined),
    onSuccess: (_result, sent) => {
      setText(current => current.trim() === sent.body ? '' : current);
      void qc.invalidateQueries({ queryKey: ['conversation', userId] });
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      void qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });
  return <SafeAreaView edges={['left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: colors.bg }}>
    <Stack.Screen options={{ title: first?.name || name || 'Messages' }} />
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={headerHeight}>
      {thread.isLoading ? <Loading /> : null}
      {thread.isError ? <Banner tone="danger" title="Could not load messages" /> : null}
      <FlatList inverted style={{ flex: 1 }} data={messages} keyExtractor={message => message.id}
        keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space(4) }}
        ListFooterComponent={thread.hasNextPage ? <Button title="Load earlier messages" variant="ghost" loading={thread.isFetchingNextPage} onPress={() => { void thread.fetchNextPage(); }} /> : null}
        renderItem={({ item }) => {
          const mine = item.sender_user_id === me?.id;
          return <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '88%', marginBottom: space(3) }}>
            <Muted>{item.requestTitle}</Muted>
            <View style={{ backgroundColor: mine ? colors.brand : colors.surface, padding: space(3), borderRadius: radius.md }}>
              <Text style={{ color: mine ? '#fff' : colors.text, fontSize: 15 }}>{item.body}</Text>
            </View>
            <Muted>{formatDateTime(item.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</Muted>
          </View>;
        }} />
      <View style={{ padding: space(3), backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border }}>
        {selected ? <Pressable onPress={() => setChoosingJob(current => !current)} accessibilityRole="button" style={{ paddingBottom: space(2) }}>
          <Text style={{ color: colors.brand, fontWeight: '600' }}>Job: {selected.title}{requests.length > 1 ? ' · Change' : ''}</Text>
        </Pressable> : <Muted>There is no job available to reply to.</Muted>}
        {choosingJob ? <FlatList style={{ maxHeight: 150 }} data={requests} keyExtractor={request => request.id}
          keyboardShouldPersistTaps="handled" renderItem={({ item }) => <Pressable style={{ paddingVertical: 10 }} onPress={() => { setRequestId(item.id); setChoosingJob(false); }}><Text>{item.title} · {item.id.slice(0, 8)}</Text></Pressable>} /> : null}
        {send.isError ? <Banner tone="danger" title="Message was not sent" body="Your text is saved below. Try again." /> : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <TextInput accessibilityLabel="Message" placeholder="Write a message" multiline maxLength={2000}
            value={text} onChangeText={value => { if (!requestId && selected) setRequestId(selected.id); setText(value); }} editable={!send.isPending}
            style={{ flex: 1, minHeight: 44, maxHeight: 120, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text }} />
          <Button title="Send" small loading={send.isPending} disabled={!text.trim() || !selected}
            onPress={() => { if (selected && text.trim()) send.mutate({ body: text.trim(), jobId: selected.id }); }} />
        </View>
      </View>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}
