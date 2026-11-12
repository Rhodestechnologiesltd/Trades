import { useState } from 'react';
import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { Avatar, Card, ConfirmSheet, Divider, H2, ListItem, Muted, Row, Screen, Spacer, errorMessage, useApi, useSession } from '@trades/mobile-ui';

export default function Account() {
  const { me, signOut } = useSession();
  const api = useApi();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  return (
    <Screen>
      <Card>
        <Row gap={3}>
          <Avatar name={me.full_name} size={56} />
          <View style={{ flex: 1 }}>
            <H2>{me.full_name}</H2>
            <Muted>{me.phone_number}{me.email ? ` · ${me.email}` : ''}</Muted>
          </View>
        </Row>
      </Card>
      <Card>
        <ListItem icon="location" title="Saved addresses" onPress={() => router.push('/addresses')} />
        <ListItem icon="repeat" title="Regular services" subtitle="Recurring cleaning, childcare, gardening…" onPress={() => router.push('/recurring')} />
        <ListItem icon="phone-portrait" title="Devices & sessions" onPress={() => router.push('/settings/sessions')} />
      </Card>
      <Card>
        <ListItem icon="help-buoy" title="Help & support" subtitle="support@trades.mu · +230 400 0000" />
        <ListItem icon="document-text" title="Terms & privacy" />
      </Card>
      <Card>
        <ListItem icon="log-out" title="Sign out" onPress={() => signOut().then(() => router.replace('/(auth)/welcome'))} />
        <Divider />
        <ListItem icon="trash" iconColor="#C53030" title="Delete my account" onPress={() => setConfirmDelete(true)} />
      </Card>
      <Spacer h={2} />
      <Muted center>Trades v1.0 · Payments processed securely by MIPS</Muted>
      <ConfirmSheet
        visible={confirmDelete} onClose={() => setConfirmDelete(false)} danger loading={busy}
        title="Delete account?" confirmLabel="Delete permanently"
        body="Your personal details will be erased. Records we must keep by law (payments, receipts) are retained in anonymised form."
        onConfirm={async () => {
          setBusy(true);
          try { await api.me.deleteAccount(); await signOut(); router.replace('/(auth)/welcome'); } catch (e) { Alert.alert('Cannot delete yet', errorMessage(e)); } finally { setBusy(false); setConfirmDelete(false); }
        }}
      />
    </Screen>
  );
}
