import type {
  Address, BookingListItem, BookingView, Category, DisputeReason, DisputeView, Earnings, JobFeedItem, Me, NotificationItem, OtpChallenge, Page,
  PaymentInit, ProviderMe, RecurringAgreement, RequestListItem, RequestMode, Review, ServiceRequest, TokenPair,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export interface TokenStore {
  get(): Promise<{ accessToken: string; refreshToken: string } | null>;
  set(t: { accessToken: string; refreshToken: string } | null): Promise<void>;
}

export interface ApiOptions {
  baseUrl: string;
  tokens: TokenStore;
  /** Called when refresh fails (session revoked/expired) so the app can route to login. */
  onSessionEnded?: () => void;
  fetchImpl?: typeof fetch;
}

/** Idempotency keys for money-moving / state-changing POSTs (§E). */
export function newIdempotencyKey(): string {
  const g: any = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'idk-' + Date.now().toString(36) + '-' + Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 10)).join('');
}

type Q = Record<string, string | number | boolean | undefined | null>;
const qs = (q?: Q) => {
  if (!q) return '';
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

export function createApi(opts: ApiOptions) {
  const f = opts.fetchImpl ?? fetch;
  let refreshing: Promise<boolean> | null = null;

  async function refresh(): Promise<boolean> {
    const t = await opts.tokens.get();
    if (!t?.refreshToken) return false;
    try {
      const res = await f(`${opts.baseUrl}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: t.refreshToken }) });
      if (!res.ok) { await opts.tokens.set(null); opts.onSessionEnded?.(); return false; }
      const pair = (await res.json()) as TokenPair;
      await opts.tokens.set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
      return true;
    } catch {
      return false;
    }
  }

  async function request<T>(method: string, path: string, body?: unknown, o: { idempotent?: boolean | string; auth?: boolean; raw?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (o.idempotent) headers['idempotency-key'] = typeof o.idempotent === 'string' ? o.idempotent : newIdempotencyKey();
    const send = async () => {
      if (o.auth !== false) {
        const t = await opts.tokens.get();
        if (t?.accessToken) headers.authorization = `Bearer ${t.accessToken}`;
      }
      return f(`${opts.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    let res = await send();
    if (res.status === 401 && o.auth !== false) {
      refreshing ??= refresh().finally(() => { refreshing = null; });
      if (await refreshing) res = await send(); // same idempotency key on retry
    }
    if (o.raw) return res as any;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const e = json?.error ?? {};
      throw new ApiError(res.status, e.code ?? 'http_error', e.message ?? `Request failed (${res.status})`, e.details);
    }
    return json as T;
  }

  const get = <T>(p: string, q?: Q) => request<T>('GET', p + qs(q));
  const post = <T>(p: string, b?: unknown, idempotent = false) => request<T>('POST', p, b ?? {}, { idempotent });
  const put = <T>(p: string, b: unknown) => request<T>('PUT', p, b);
  const patch = <T>(p: string, b: unknown) => request<T>('PATCH', p, b);
  const del = <T>(p: string) => request<T>('DELETE', p);

  return {
    request,
    auth: {
      registerCustomer: (d: { phone: string; fullName: string; email?: string }) => request<OtpChallenge>('POST', '/v1/auth/customers/register', d, { auth: false }),
      registerProvider: (d: { phone: string; fullName: string; email?: string; businessName?: string }) => request<OtpChallenge>('POST', '/v1/auth/providers/register', d, { auth: false }),
      requestOtp: (phone: string) => request<OtpChallenge>('POST', '/v1/auth/otp/request', { phone }, { auth: false }),
      verifyOtp: (d: { phone: string; code: string; deviceId: string; deviceName?: string; platform?: 'ios' | 'android' | 'web'; app?: 'customer' | 'provider'; isRooted?: boolean }) =>
        request<TokenPair>('POST', '/v1/auth/otp/verify', d, { auth: false }),
      staffLogin: (d: { email: string; password: string; totp: string; deviceId: string }) => request<TokenPair>('POST', '/v1/auth/staff/login', d, { auth: false }),
      logout: () => post<{ ok: true }>('/v1/auth/logout'),
      sessions: () => get<Array<{ id: string; device_name: string | null; platform: string | null; created_at: string; last_seen_at: string; current: boolean }>>('/v1/auth/sessions'),
      revokeSession: (id: string) => del<{ ok: true }>(`/v1/auth/sessions/${id}`),
      startStepUp: () => post<OtpChallenge>('/v1/auth/step-up/start'),
    },
    me: {
      get: () => get<Me>('/v1/me'),
      update: (d: { fullName?: string; email?: string; locale?: string; avatarKey?: string }) => patch<Me>('/v1/me', d),
      deleteAccount: () => post<{ ok: true }>('/v1/me/delete'),
      registerPushToken: (token: string, platform: 'ios' | 'android' | 'web') => post<{ ok: true }>('/v1/me/push-tokens', { token, platform }),
      setNotificationPrefs: (preferences: Array<{ eventType: string; channels: string[] }>) => put('/v1/me/notification-preferences', { preferences }),
    },
    catalog: {
      publicConfig: (marketId?: string) => get<{ currency: string; customerFeePct: number; providerCommissionPct: number; payoutDelayHours: number; disputeWindowHours: number; autoApproveHours: number }>('/v1/config/public', { marketId }),
      categories: () => request<Category[]>('GET', '/v1/categories', undefined, { auth: false }),
      priceBands: (categoryId: string, marketId: string) => get<Array<{ sku_name: string; suggested_min: string; suggested_max: string; currency_code: string }>>(`/v1/categories/${categoryId}/price-bands`, { marketId }),
    },
    addresses: {
      list: () => get<Address[]>('/v1/customers/me/addresses'),
      create: (d: Partial<Address> & { line1: string; city: string; lat: number; lng: number; makeDefault?: boolean; accessNotes?: string; precisionLevel?: string }) => post<Address>('/v1/customers/me/addresses', d),
      update: (id: string, d: Record<string, unknown>) => patch<Address>(`/v1/customers/me/addresses/${id}`, d),
      remove: (id: string) => del<{ ok: true }>(`/v1/customers/me/addresses/${id}`),
    },
    requests: {
      create: (d: {
        categoryId: string; mode: RequestMode; title?: string; description: string; photoKeys?: string[]; scheduledFor?: string; scheduledWindowMin?: number;
        urgencyLevel?: 'normal' | 'high' | 'critical'; budgetHint?: string; addressId?: string; precisionLevel?: 'exact' | 'approximate'; instantAccept?: boolean;
        location?: { lat: number; lng: number; source: 'gps' | 'manual'; addressText?: string; areaLabel?: string };
      }) => post<ServiceRequest>('/v1/service-requests', d, true),
      list: (q?: { cursor?: string; status?: string }) => get<Page<RequestListItem>>('/v1/service-requests', q),
      get: (id: string) => get<ServiceRequest>(`/v1/service-requests/${id}`),
      cancel: (id: string, reason?: string) => post<ServiceRequest>(`/v1/service-requests/${id}/cancel`, { reason }),
      messages: (id: string, withUser?: string) => get<Array<{ id: string; sender_user_id: string; body: string; redacted: boolean; created_at: string }>>(`/v1/service-requests/${id}/messages`, { with: withUser }),
      sendMessage: (id: string, body: string, toProviderId?: string) => post(`/v1/service-requests/${id}/messages`, { body, toProviderId }),
    },
    quotes: {
      submit: (d: { requestId: string; amount: string; message?: string; estimatedStartAt?: string; estimatedDurationMin?: number; validForMin?: number }) => post<any>('/v1/quotes', d, true),
      mine: (status?: string) => get<any[]>('/v1/quotes/mine', { status }),
      withdraw: (id: string) => post(`/v1/quotes/${id}/withdraw`),
      counter: (quoteId: string, amount: string, message?: string) => post(`/v1/quotes/${quoteId}/counter-offers`, { amount, message }, true),
      respond: (counterId: string, action: 'accept' | 'reject' | 'counter', amount?: string, message?: string) =>
        post<{ action: string; bookingId?: string; standingOffer?: string }>(`/v1/counter-offers/${counterId}/respond`, { action, amount, message }, true),
      accept: (quoteId: string) => post<{ bookingId: string }>(`/v1/quotes/${quoteId}/accept`, {}, true),
      instantAccept: (requestId: string) => post<{ bookingId: string }>(`/v1/service-requests/${requestId}/instant-accept`, {}, true),
    },
    dispatch: {
      decline: (requestId: string, reason?: string) => post(`/v1/dispatch/${requestId}/decline`, { reason }),
      jobs: (radiusM?: number) => get<{ dispatched: JobFeedItem[]; open: JobFeedItem[] }>('/v1/geo/jobs', { radiusM }),
      providersNear: (lat: number, lng: number, categoryId?: string, radiusM = 10000) =>
        get<Array<{ id: string; name: string; rating: string | null; ratingCount: number; online: boolean; approxLat: number; approxLng: number; distanceM: number }>>('/v1/geo/providers', { lat, lng, categoryId, radiusM }),
    },
    bookings: {
      history: (q?: { cursor?: string; status?: 'active' | 'past' }) => get<Page<BookingListItem>>('/v1/bookings/history', q),
      get: (id: string) => get<BookingView>(`/v1/bookings/${id}`),
      tracking: (id: string) => get<{ available: boolean; lat?: number; lng?: number; at?: string; distanceM?: number; etaMin?: number }>(`/v1/bookings/${id}/tracking`),
      pay: (id: string, returnUrl?: string) => post<PaymentInit>(`/v1/bookings/${id}/payment`, { returnUrl }, true),
      verifyPayment: (paymentId: string) => get<{ id: string; status: string; booking_status: string; failure_code: string | null }>(`/v1/payments/${paymentId}/verify`),
      start: (id: string, loc?: { lat: number; lng: number; accuracyM?: number }) => post(`/v1/bookings/${id}/start`, loc ?? {}, true),
      complete: (id: string, d: { notes?: string; photoKeys?: string[]; lat?: number; lng?: number }) => post(`/v1/bookings/${id}/complete`, d, true),
      jobEvent: (id: string, d: { type: 'en_route' | 'arrived' | 'photo_uploaded' | 'note_added'; lat?: number; lng?: number; note?: string; photoKeys?: string[]; etaMin?: number }) => post(`/v1/bookings/${id}/job-events`, d),
      approve: (id: string) => post<{ status: string; payoutEligibleAt: string }>(`/v1/bookings/${id}/approve`, {}, true),
      cancel: (id: string, reason: string) => post<{ status: string; outcome: string; refund: string | null }>(`/v1/bookings/${id}/cancel`, { reason }, true),
      reportNoShow: (id: string, reason: string) => post(`/v1/bookings/${id}/no-show`, { reason }, true),
    },
    disputes: {
      open: (d: { bookingId: string; reasonCode: DisputeReason; description: string; evidenceKeys?: string[] }) => post<{ id: string }>('/v1/disputes', d, true),
      mine: () => get<any[]>('/v1/disputes/mine'),
      get: (id: string) => get<DisputeView>(`/v1/disputes/${id}`),
      message: (id: string, body: string, attachmentKeys?: string[], internalOnly?: boolean) => post(`/v1/disputes/${id}/messages`, { body, attachmentKeys, internalOnly }),
      withdraw: (id: string) => post(`/v1/disputes/${id}/withdraw`),
    },
    reviews: {
      create: (d: { bookingId: string; rating: number; comment?: string; breakdown?: Record<string, number> }) => post('/v1/reviews', d, true),
      forUser: (userId: string) => get<Review[]>(`/v1/users/${userId}/reviews`),
    },
    notifications: {
      feed: (cursor?: string) => get<Page<NotificationItem> & { unreadCount: number }>('/v1/notifications', { cursor }),
      read: (id: string) => post(`/v1/notifications/${id}/read`),
      readAll: () => post('/v1/notifications/read-all'),
    },
    media: {
      uploadUrl: (purpose: string, contentType: string, sizeBytes: number) =>
        post<{ key: string; uploadUrl: string; method: 'PUT'; headers: Record<string, string> }>('/v1/media/upload-url', { purpose, contentType, sizeBytes }),
    },
    providers: {
      me: () => get<ProviderMe>('/v1/providers/me'),
      publicProfile: (id: string) => get<any>(`/v1/providers/${id}`),
      updateProfile: (d: Record<string, unknown>) => patch<ProviderMe>('/v1/providers/me/profile', d),
      setCategories: (categories: Array<{ categoryId: string; priceBandMin?: string; priceBandMax?: string }>) => put<ProviderMe>('/v1/providers/me/categories', { categories }),
      setLocations: (d: { homeBase: { lat: number; lng: number }; zones: Array<Record<string, unknown>> }) => put<ProviderMe>('/v1/providers/me/locations', d),
      setAvailability: (status: 'online' | 'offline' | 'busy') => patch<{ availabilityStatus: string }>('/v1/providers/me/availability', { status }),
      ping: (d: { lat: number; lng: number; accuracyM?: number; isMocked?: boolean; recordedAt?: string; bookingId?: string }) => post<{ accepted: boolean }>('/v1/providers/me/location-ping', d),
      addDocument: (d: { kind: string; storageKey: string; categoryId?: string; expiresAt?: string }) => post('/v1/providers/me/documents', d),
      submitVerification: () => post<{ verificationStatus: string }>('/v1/providers/me/submit-verification'),
      setPayoutAccount: (d: { method: 'bank_transfer' | 'mobile_wallet'; accountHolderName: string; bankName?: string; accountNumber: string; bankCode?: string; stepUpCode: string }) => put('/v1/providers/me/payout-account', d),
      earnings: () => get<Earnings>('/v1/providers/me/earnings'),
      setAvailabilityWindows: (windows: Array<{ weekday: number; start: string; end: string }>) => put('/v1/providers/me/availability-windows', { windows }),
      addTimeOff: (startsAt: string, endsAt: string) => post('/v1/providers/me/time-off', { startsAt, endsAt }),
    },
    recurring: {
      list: () => get<RecurringAgreement[]>('/v1/recurring-agreements'),
      create: (d: { categoryId: string; addressId: string; cadenceRule: string; startsOn: string; durationMin?: number; description: string; preferredProviderId?: string; agreedRate?: string }) =>
        post<RecurringAgreement>('/v1/recurring-agreements', d),
      setStatus: (id: string, action: 'pause' | 'resume' | 'cancel') => post(`/v1/recurring-agreements/${id}/status`, { action }),
    },
    admin: {
      dashboard: (marketId?: string) => get<any>('/v1/admin/dashboard', { marketId }),
      analytics: (kind: string, days = 30) => get<any>(`/v1/admin/analytics/${kind}`, { days }),
      providers: (status = 'pending') => get<any[]>('/v1/admin/providers', { status }),
      provider: (id: string) => get<any>(`/v1/admin/providers/${id}`),
      decideVerification: (id: string, decision: 'approve' | 'reject', reason?: string) => post(`/v1/admin/providers/${id}/verification`, { decision, reason }),
      reviewDocument: (id: string, status: 'approved' | 'rejected', notes?: string) => post(`/v1/admin/documents/${id}/review`, { status, notes }),
      users: (q?: string, type?: string) => get<any[]>('/v1/admin/users', { q, type }),
      setUserStatus: (id: string, status: string, reason: string) => post(`/v1/admin/users/${id}/status`, { status, reason }),
      createStaff: (d: { email: string; fullName: string; role: string; password: string }) => post<any>('/v1/admin/staff', d),
      categories: () => get<any[]>('/v1/admin/categories'),
      createCategory: (d: Record<string, unknown>) => post('/v1/admin/categories', d),
      updateCategory: (id: string, d: Record<string, unknown>) => patch(`/v1/admin/categories/${id}`, d),
      markets: () => get<any[]>('/v1/admin/markets'),
      updateMarket: (id: string, d: Record<string, unknown>) => patch(`/v1/admin/markets/${id}`, d),
      config: () => get<Array<{ key: string; value: any; description: string | null; updated_at: string }>>('/v1/admin/config'),
      setConfig: (key: string, value: unknown, reason: string) => put(`/v1/admin/config/${key}`, { value, reason }),
      bookings: (q?: { status?: string; q?: string }) => get<any[]>('/v1/admin/bookings', q),
      booking: (id: string) => get<any>(`/v1/admin/bookings/${id}`),
      requests: (q?: { status?: string; adminAssist?: boolean }) => get<any[]>('/v1/admin/requests', q),
      redispatch: (requestId: string) => post(`/v1/dispatch/${requestId}/dispatch`),
      goodwillRefund: (bookingId: string, amount: string, reason: string) => post(`/v1/admin/bookings/${bookingId}/goodwill-refund`, { amount, reason }, true),
      refunds: (status?: string) => get<any[]>('/v1/admin/refunds', { status }),
      markRefundPaid: (id: string, bankReference: string) => post(`/v1/admin/refunds/${id}/mark-paid`, { bankReference }, true),
      chargeback: (d: Record<string, unknown>) => post('/v1/admin/chargebacks', d, true),
      disputes: (q?: { status?: string; routedTo?: string }) => get<any[]>('/v1/disputes', q),
      dispute: (id: string) => get<DisputeView>(`/v1/disputes/${id}`),
      disputeStartReview: (id: string) => post(`/v1/disputes/${id}/start-review`),
      disputeRequestEvidence: (id: string, message: string, dueInHours?: number) => post(`/v1/disputes/${id}/request-evidence`, { message, dueInHours }),
      disputeMessage: (id: string, body: string, internalOnly: boolean) => post(`/v1/disputes/${id}/messages`, { body, internalOnly }),
      resolveDispute: (id: string, d: { resolution: string; adjustedAmount?: string; notes: string }) =>
        post<{ resolution: string; refundToCustomer: string; providerPayout: string; clawback: string }>(`/v1/disputes/${id}/resolve`, d, true),
      payouts: (status?: string) => get<any[]>('/v1/payouts', { status }),
      releasePayout: (bookingId: string, reason: string) => post(`/v1/payouts/${bookingId}/release`, { reason }, true),
      holdPayout: (bookingId: string, reason: string) => post(`/v1/payouts/${bookingId}/hold`, { reason }),
      unholdPayout: (bookingId: string, reason: string) => post(`/v1/payouts/${bookingId}/unhold`, { reason }),
      exportBatch: (marketId: string) => request<Response>('POST', `/v1/payouts/batches/export?marketId=${marketId}`, {}, { raw: true }),
      confirmBatch: (payoutIds: string[], bankReference: string) => post('/v1/payouts/batches/confirm', { payoutIds, bankReference }, true),
      writeOffClawback: (id: string, reason: string) => post(`/v1/payouts/clawbacks/${id}/write-off`, { reason }),
      trialBalance: (currency?: string) => get<Array<{ account: string; currency_code: string; balance: string }>>('/v1/admin/ledger/trial-balance', { currency }),
      journals: (q?: { bookingId?: string; kind?: string; from?: string; to?: string }) => get<any[]>('/v1/admin/ledger/journals', q),
      importSettlement: (d: Record<string, unknown>) => post('/v1/admin/ledger/settlement-reports', d),
      reconcile: (date: string, currency: string) => post<any>('/v1/admin/ledger/reconcile', { date, currency }),
      reconciliationRuns: () => get<any[]>('/v1/admin/ledger/reconciliation-runs'),
      auditLogs: (q?: { entityType?: string; entityId?: string; actorId?: string; action?: string }) => get<any[]>('/v1/admin/audit-logs', q),
      fraudSignals: (status = 'open') => get<any[]>('/v1/admin/fraud-signals', { status }),
      updateFraudSignal: (id: string, status: string, note?: string) => post(`/v1/admin/fraud-signals/${id}`, { status, note }),
      flaggedReviews: () => get<any[]>('/v1/admin/reviews/flagged'),
      setReviewVisibility: (id: string, hidden: boolean, reason: string) => post(`/v1/admin/reviews/${id}/visibility`, { hidden, reason }),
      failedNotifications: () => get<any[]>('/v1/admin/notifications/failed'),
      retryNotification: (id: string) => post(`/v1/admin/notifications/${id}/retry`),
      nearbyProviders: (lat: number, lng: number, radiusM?: number, categoryId?: string) => get<any[]>('/v1/dispatch/nearby-providers', { lat, lng, radiusM, categoryId }),
      dispatchLog: (requestId: string) => get<any[]>(`/v1/dispatch/${requestId}/log`),
    },
  };
}

export type Api = ReturnType<typeof createApi>;

/** Upload a local file (RN uri or browser Blob) through a presigned PUT. Returns the storage key. */
export async function uploadFile(api: Api, purpose: string, file: { blob: Blob; contentType: string; size: number }): Promise<string> {
  const u = await api.media.uploadUrl(purpose, file.contentType, file.size);
  const res = await fetch(u.uploadUrl, { method: 'PUT', headers: u.headers, body: file.blob });
  if (!res.ok) throw new ApiError(res.status, 'upload_failed', 'Upload failed. Please try again.');
  return u.key;
}
