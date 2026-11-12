import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { Button, Muted, colors, radius, space } from '@trades/mobile-ui';

export interface PickedLocation { lat: number; lng: number; source: 'gps' | 'manual'; addressText?: string; areaLabel?: string; city?: string }

const MAURITIUS: Region = { latitude: -20.2, longitude: 57.55, latitudeDelta: 0.6, longitudeDelta: 0.6 };

/**
 * Pin-on-map location capture (§K risks: manual pin adjustment mitigates GPS drift).
 * Reverse-geocodes for a friendly area label; the server re-validates coordinates.
 */
export function MapPicker({ value, onChange, height = 260 }: { value: PickedLocation | null; onChange: (l: PickedLocation) => void; height?: number }) {
  const map = useRef<MapView>(null);
  const [locating, setLocating] = useState(false);
  const [denied, setDenied] = useState(false);

  async function describe(lat: number, lng: number, source: 'gps' | 'manual') {
    try {
      const [g] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      const addressText = g ? [g.streetNumber, g.street, g.district, g.city].filter(Boolean).join(', ') : undefined;
      onChange({ lat, lng, source, addressText, areaLabel: g?.district ?? g?.city ?? g?.subregion ?? undefined, city: g?.city ?? g?.subregion ?? undefined });
    } catch {
      onChange({ lat, lng, source });
    }
  }

  async function locate() {
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setDenied(true); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = pos.coords;
      map.current?.animateToRegion({ latitude, longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 }, 400);
      await describe(latitude, longitude, 'gps');
    } finally {
      setLocating(false);
    }
  }

  useEffect(() => { if (!value) locate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View>
      <View style={[styles.wrap, { height }]}>
        <MapView
          ref={map} style={StyleSheet.absoluteFill}
          initialRegion={value ? { latitude: value.lat, longitude: value.lng, latitudeDelta: 0.01, longitudeDelta: 0.01 } : MAURITIUS}
          onLongPress={e => describe(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude, 'manual')}
          showsUserLocation
        >
          {value ? (
            <Marker draggable coordinate={{ latitude: value.lat, longitude: value.lng }} pinColor={colors.brand}
              onDragEnd={e => describe(e.nativeEvent.coordinate.latitude, e.nativeEvent.coordinate.longitude, 'manual')} />
          ) : null}
        </MapView>
        {locating ? <View style={styles.overlay}><ActivityIndicator color={colors.brand} /></View> : null}
      </View>
      <Muted>{value?.addressText ?? (denied ? 'Location permission denied — long-press the map to drop a pin.' : 'Drag the pin or long-press to set the exact spot.')}</Muted>
      <View style={{ height: space(2) }} />
      <Button title="Use my current location" icon="locate" variant="secondary" small onPress={locate} />
      {value ? <Text style={{ fontSize: 11, color: colors.textFaint, marginTop: 4 }}>{value.lat.toFixed(5)}, {value.lng.toFixed(5)}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.neutralSoft, marginBottom: space(2) },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.5)' },
});
