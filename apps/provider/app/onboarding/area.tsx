import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import MapView, { Circle, Marker } from 'react-native-maps';
import Slider from '@react-native-community/slider';
import { useQueryClient } from '@tanstack/react-query';
import { Banner, Body, Button, Muted, Screen, Spacer, colors, errorMessage, radius, useApi } from '@trades/mobile-ui';
import { currentPosition } from '../../src/location';
import { useProviderMe } from '../../src/hooks';

export default function Area() {
  const me = useProviderMe().data;
  const api = useApi();
  const qc = useQueryClient();
  const map = useRef<any>(null);
  const [home, setHome] = useState<{ lat: number; lng: number } | null>(null);
  const [km, setKm] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me?.home_base_lat != null && me.home_base_lng != null) {
      setHome({ lat: me.home_base_lat, lng: me.home_base_lng });
      if (me.zones[0]?.radius_meters) setKm(Math.round(me.zones[0].radius_meters / 1000));
    } else currentPosition().then(p => p && setHome({ lat: p.lat, lng: p.lng }));
  }, [me]);

  async function save() {
    if (!home) return setError('Set your home base on the map');
    setBusy(true);
    try {
      await api.providers.setLocations({ homeBase: home, zones: [{ type: 'radius', centerLat: home.lat, centerLng: home.lng, radiusM: km * 1000, isPrimary: true }] });
      qc.invalidateQueries({ queryKey: ['provider-me'] });
      router.back();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <Screen footer={<Button title="Save work area" onPress={save} loading={busy} />}>
      {error ? <Banner tone="danger" title={error} /> : null}
      <Muted>Long-press the map to set your home base (it is never shown to customers). Jobs outside your area won't be sent to you.</Muted>
      <Spacer h={3} />
      <View style={styles.map}>
        <MapView ref={map} style={StyleSheet.absoluteFill}
          region={home ? { latitude: home.lat, longitude: home.lng, latitudeDelta: km / 40, longitudeDelta: km / 40 } : { latitude: -20.2, longitude: 57.55, latitudeDelta: 0.6, longitudeDelta: 0.6 }}
          onLongPress={(e: any) => setHome({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude })}>
          {home ? <Marker coordinate={{ latitude: home.lat, longitude: home.lng }} pinColor={colors.brand} /> : null}
          {home ? <Circle center={{ latitude: home.lat, longitude: home.lng }} radius={km * 1000} strokeColor={colors.brand} fillColor="rgba(14,124,102,0.12)" /> : null}
        </MapView>
      </View>
      <Spacer h={4} />
      <Body style={{ fontWeight: '700' }}>I travel up to {km} km</Body>
      <Slider minimumValue={2} maximumValue={60} step={1} value={km} onValueChange={(v: number) => setKm(v)} minimumTrackTintColor={colors.brand} />
      <Muted>For urgent jobs we start with the closest pros, so a wider area means more jobs but longer drives.</Muted>
    </Screen>
  );
}

const styles = StyleSheet.create({ map: { height: 320, borderRadius: radius.lg, overflow: 'hidden' } });
