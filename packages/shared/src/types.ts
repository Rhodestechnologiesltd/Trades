/** API DTOs (mirrors backend responses). Money is always { amount: "1234.50", currency: "MUR" } or a decimal string + currency. */
export type Role = 'customer' | 'provider' | 'admin' | 'support' | 'finance';
export type RequestMode = 'scheduled' | 'urgent' | 'recurring';
export type RequestStatus = 'draft' | 'requested' | 'matching' | 'dispatched' | 'quoted' | 'accepted' | 'expired' | 'cancelled';
export type BookingStatus = 'payment_pending' | 'payment_authorized' | 'assigned' | 'in_progress' | 'completed_by_provider' | 'approved_by_customer'
  | 'payout_pending' | 'payout_released' | 'cancelled' | 'disputed' | 'refund_pending' | 'refunded';
export type QuoteStatus = 'submitted' | 'active' | 'countered' | 'accepted' | 'expired' | 'withdrawn' | 'closed';
export type DisputeReason = 'no_show' | 'incomplete_work' | 'damage' | 'overcharge' | 'unsafe_conduct' | 'other';

export interface ApiMoney { amount: string; currency: string }

export interface TokenPair {
  accessToken: string; refreshToken: string; expiresIn: number; newDevice?: boolean;
  user: { id: string; type: Role; fullName: string; status: string; marketId: string | null };
}
export interface OtpChallenge { challengeId: string; expiresInSec: number; devCode?: string }

export interface Market { id: string; country_code: string; city: string; currency_code: string; timezone: string }
export interface Me {
  id: string; phone_number: string | null; email: string | null; full_name: string; avatar_url: string | null; user_type: Role; status: string;
  market: Market | null; locale: string;
  // customer
  default_address_id?: string | null; rating_avg?: string | null; rating_count?: number;
  // provider
  business_name?: string | null; verification_status?: 'unverified' | 'pending' | 'verified' | 'rejected'; availability_status?: 'online' | 'offline' | 'busy';
  max_concurrent_jobs?: number; current_active_jobs?: number; instant_accept_enabled?: boolean; rejection_reason?: string | null;
}

export interface Category {
  id: string; slug: string; name: string; icon: string | null; parentId: string | null; requiresLicense: boolean; requiresBackgroundCheck: boolean;
  urgencyAllowed: boolean; averageJobDurationMin: number; instantAcceptPrice: string | null; priceFloor: string | null; priceCeiling: string | null;
  children: Category[];
}

export interface Address {
  id: string; label: string; line1: string; line2: string | null; city: string; postal_code: string | null; access_notes: string | null;
  lat: number; lng: number; precision_level: 'exact' | 'approximate'; is_default?: boolean;
}

export interface Location { lat: number; lng: number; precision: 'exact' | 'approximate'; areaLabel?: string | null; addressText?: string | null; accessNotes?: string | null }

export interface CounterOffer {
  id: string; quote_id: string; proposed_by: 'customer' | 'provider'; amount: string; currency_code: string; message: string | null;
  round_number: number; status: 'proposed' | 'accepted' | 'rejected' | 'expired' | 'countered'; valid_until: string; created_at: string;
}

export interface QuoteView {
  id: string; amount: string; currency: string; message: string | null; status: QuoteStatus; validUntil: string;
  estimatedStartAt: string | null; estimatedDurationMin: number | null; isInstantAccept: boolean; etaMin: number | null; distanceM: number | null;
  provider: { id: string; name: string; avatarUrl: string | null; rating: string | null; ratingCount: number; verified: boolean; jobsCompleted: number };
  counterOffers: CounterOffer[];
}

export interface ServiceRequest {
  id: string; status: RequestStatus; mode: RequestMode; title: string; description: string; photos: string[];
  category: { id: string; name: string; slug: string; icon: string | null };
  scheduledFor: string | null; scheduledWindowMin: number | null; urgencyLevel: string; budgetHint: string | null; currency: string;
  createdAt: string; expiresAt: string | null; instantAcceptPrice: string | null; bookingId: string | null; bookingStatus: BookingStatus | null;
  location: Location; customer: { firstName: string; rating: string | null; ratingCount: number };
  // customer view
  quotes?: QuoteView[]; dispatchStats?: { notified: number; viewed: number; declined: number }; searchRadiusM?: number;
  // provider view
  dispatch?: { status: string; responseDeadline: string | null } | null; distanceM?: number | null; etaMin?: number | null;
  myQuote?: (Record<string, any> & { id: string; amount: string; status: QuoteStatus; counterOffers: CounterOffer[] }) | null;
}

export interface RequestListItem {
  id: string; status: RequestStatus; request_mode: RequestMode; title: string; scheduled_for: string | null; created_at: string; currency_code: string;
  category_name: string; category_icon: string | null; live_quotes: number; best_quote: string | null; booking_id: string | null; booking_status: BookingStatus | null;
}

export interface TimelineEvent { from_state: string | null; to_state: string; trigger: string; actor_type: string; occurred_at: string; metadata: any }

export interface BookingView {
  id: string; reference: string; status: BookingStatus; requestId: string; title: string; description: string; mode: RequestMode;
  category: { id: string; name: string; icon: string | null };
  scheduledStartAt: string | null; paymentDueAt: string; jobStartedAt: string | null; jobCompletedAt: string | null; approvedAt: string | null;
  autoApproveAt: string | null; disputeDeadlineAt: string | null; cancelledAt: string | null; cancelReason: string | null; completionNotes: string | null;
  location: Location;
  customer: { id: string; name: string; phone?: string };
  provider: { id: string; name: string; avatarUrl: string | null; rating: string | null; ratingCount: number; phone?: string };
  pricing: Partial<Record<'agreed' | 'platformFee' | 'total' | 'commission' | 'payout' | 'providerNet' | 'platformGross', ApiMoney>> & { feePct?: string; commissionPct?: string };
  payment: { id: string; status: string; card_brand: string | null; card_last4: string | null; captured_at: string | null; amount_refunded: string } | null;
  payout: { status: string; eligible_at: string; released_at: string | null; net_payout_amount: string; clawback_recovered: string; hold_reason: string | null } | null;
  dispute: { id: string; status: string; reason_code: DisputeReason; resolution: string | null; opened_at: string } | null;
  myReview: { rating: number; comment: string | null; created_at: string } | null;
  tracking: { lat: number; lng: number; at: string } | null;
  photos: string[];
  availableActions: string[];
  timeline: TimelineEvent[];
  jobEvents: Array<{ event_type: string; payload: any; occurred_at: string; within_geofence: boolean | null }>;
}

export interface BookingListItem {
  id: string; reference: string; status: BookingStatus; agreed_amount: string; currency_code: string; scheduled_start_at: string | null; created_at: string;
  job_completed_at: string | null; title: string; request_mode: RequestMode; category_name: string; category_icon: string | null; area_label: string | null;
  counterparty_name: string; reviewed: boolean;
}

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface NotificationItem { id: string; event_type: string; title: string; body: string; payload: any; read_at: string | null; created_at: string }

export interface PaymentInit { paymentId: string; redirectUrl: string; expiresAt?: string; breakdown: { agreedAmount: string; platformFee: string; total: string; feePct: string; currency: string } }

export interface JobFeedItem {
  id: string; title: string; request_mode: RequestMode; status: RequestStatus; scheduled_for: string | null; urgency_level: string; budget_hint: string | null;
  currency_code: string; created_at: string; category_name: string; category_icon: string | null; approx_lat: number; approx_lng: number; area_label: string | null;
  distance_m: number; eta_min: number; dispatch_status?: string; response_deadline?: string | null; my_quote_status?: QuoteStatus | null;
}

export interface ProviderMe extends Record<string, any> {
  id: string; full_name: string; business_name: string | null; verification_status: string; availability_status: 'online' | 'offline' | 'busy';
  rating_avg: string | null; rating_count: number; max_concurrent_jobs: number; instant_accept_enabled: boolean; home_base_lat: number | null; home_base_lng: number | null;
  bio: string | null; years_experience: number | null; languages: string[]; rejection_reason: string | null;
  categories: Array<{ category_id: string; name: string; slug: string; requires_license: boolean; approved: boolean; rating_avg: string | null; rating_count: number }>;
  zones: Array<{ id: string; zone_type: 'radius' | 'polygon'; center_lat: number; center_lng: number; radius_meters: number; city: string | null }>;
  documents: Array<{ id: string; kind: string; category_id: string | null; status: string; expires_at: string | null; notes: string | null }>;
  payoutAccount: { id: string; method: string; account_holder_name: string; bank_name: string | null; account_last4: string; payouts_allowed_after: string } | null;
  availabilityWindows: Array<{ id: string; weekday: number; start_time: string; end_time: string }>;
  onboarding: { profile: boolean; categories: boolean; location: boolean; identity: boolean; licences: boolean; payoutAccount: boolean; complete: boolean };
}

export interface Earnings {
  summary: { currency_code: string; paid_out: string; pending: string; held: string; commission_paid: string; jobs: number } | null;
  clawbackOutstanding: string;
  payouts: Array<{ id: string; booking_id: string; reference: string; gross_amount: string; commission_deducted: string; net_payout_amount: string; clawback_recovered: string; currency_code: string; status: string; eligible_at: string; released_at: string | null; hold_reason: string | null }>;
}

export interface DisputeView {
  id: string; booking_id: string; reference: string; status: string; reason_code: DisputeReason; description: string; resolution: string | null;
  resolution_amount: string | null; resolution_notes: string | null; opened_at: string; sla_due_at: string; evidence_due_at: string | null;
  customer_name: string; provider_name: string; agreed_amount: string; currency_code: string; source: string; routed_to: string;
  messages: Array<{ id: string; author_user_id: string | null; author_role: string; body: string; attachments: (string | null)[]; internal_only: boolean; created_at: string }>;
  timeline: TimelineEvent[];
}

export interface RecurringAgreement {
  id: string; category_id: string; category_name: string; cadence_rule: string; schedule: string; status: 'active' | 'paused' | 'cancelled';
  description: string; agreed_rate: string | null; currency_code: string; provider_name: string | null; nextVisits: string[]; duration_min: number;
}

export interface Review { id: string; rating: number; comment: string | null; reviewer_role: string; created_at: string; reviewer_first_name: string; category_name?: string }
