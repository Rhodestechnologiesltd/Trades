import { Events } from '../../common/outbox.service';

type Channel = 'push' | 'sms' | 'email' | 'in_app';
export interface Rendered { title: string; body: string; deepLink?: string }

/**
 * Notification matrix (spec §H). Default channels per event; users can override
 * per event type via notification_preferences (except security/financial events).
 */
export const DEFAULT_CHANNELS: Record<string, Channel[]> = {
  [`${Events.RequestCreated}:provider`]: ['push', 'in_app'],
  [`${Events.RequestCreated}:provider:urgent`]: ['push', 'sms', 'in_app'],
  [Events.RequestDispatched]: ['in_app', 'push'],
  [Events.RequestExpired]: ['push', 'in_app'],
  [Events.QuoteSubmitted]: ['push', 'in_app'],
  [Events.CounterOfferProposed]: ['push', 'in_app'],
  [Events.CounterOfferResolved]: ['push', 'in_app'],
  [`${Events.QuoteAccepted}:winner`]: ['push', 'sms', 'in_app'],
  [`${Events.QuoteAccepted}:loser`]: ['in_app'],
  [`${Events.PaymentCaptured}:customer`]: ['push', 'email', 'in_app'],
  [`${Events.PaymentCaptured}:provider`]: ['push', 'sms', 'in_app'],
  [Events.PaymentFailed]: ['push', 'in_app'],
  [Events.JobEnRoute]: ['push', 'in_app'],
  [Events.JobStarted]: ['push', 'in_app'],
  [Events.JobCompleted]: ['push', 'sms', 'in_app'],
  [Events.AutoApproveReminder]: ['push', 'sms', 'in_app'],
  [Events.JobApproved]: ['push', 'in_app'],
  [Events.PayoutReleased]: ['push', 'email', 'in_app'],
  [Events.PayoutHeld]: ['push', 'in_app'],
  [Events.BookingCancelled]: ['push', 'sms', 'in_app'],
  [Events.RefundProcessed]: ['push', 'email', 'in_app'],
  [Events.DisputeOpened]: ['push', 'email', 'in_app'],
  [Events.DisputeEvidenceRequested]: ['push', 'email', 'in_app'],
  [Events.DisputeResolved]: ['push', 'email', 'in_app'],
  [Events.ReviewPublished]: ['in_app'],
  [Events.ProviderVerified]: ['push', 'sms', 'in_app'],
  [Events.ProviderRejected]: ['push', 'email', 'in_app'],
  [Events.MessageReceived]: ['push', 'in_app'],
};

/** Events whose channels users cannot turn off (money/security/legal). */
export const MANDATORY = new Set<string>([
  `${Events.PaymentCaptured}:customer`, Events.RefundProcessed, Events.PayoutReleased,
  Events.DisputeOpened, Events.DisputeResolved, Events.BookingCancelled,
]);

const money = (p: any, key = 'amount') => (p?.[key] ? `${p.currency ?? ''} ${p[key]}`.trim() : '');

export function render(key: string, p: any): Rendered {
  const cat = p.categoryName ?? 'service';
  switch (key) {
    case `${Events.RequestCreated}:provider`:
    case `${Events.RequestCreated}:provider:urgent`:
      return { title: p.urgent ? `URGENT: ${cat} job nearby` : `New ${cat} job nearby`, body: `${p.area ?? 'Near you'} · ${(p.distanceKm ?? 0).toFixed?.(1) ?? p.distanceKm} km away. Tap to quote.`, deepLink: `trades-provider://requests/${p.requestId}` };
    case Events.RequestDispatched:
      return { title: 'Finding your pro', body: `${p.notified} ${cat} providers have been notified.`, deepLink: `trades://requests/${p.requestId}` };
    case Events.RequestExpired:
      return { title: 'No providers available', body: `We couldn't find a ${cat} provider right now. Try again or contact support.`, deepLink: `trades://requests/${p.requestId}` };
    case Events.QuoteSubmitted:
      return { title: 'New quote received', body: `${p.providerName} quoted ${money(p)}${p.etaMin ? ` · can arrive in ~${p.etaMin} min` : ''}.`, deepLink: `trades://requests/${p.requestId}` };
    case Events.CounterOfferProposed:
      return { title: 'Counter-offer received', body: `${p.fromName} proposed ${money(p)}. ${p.final ? 'This is the final round.' : ''}`.trim(), deepLink: p.recipientRole === 'provider' ? `trades-provider://quotes/${p.quoteId}` : `trades://requests/${p.requestId}` };
    case Events.CounterOfferResolved:
      return { title: p.action === 'accepted' ? 'Offer accepted' : 'Offer declined', body: p.action === 'accepted' ? `Your offer of ${money(p)} was accepted.` : `Your offer of ${money(p)} was declined.`, deepLink: `trades://requests/${p.requestId}` };
    case `${Events.QuoteAccepted}:winner`:
      return { title: 'You won the job!', body: `Your ${cat} quote of ${money(p)} was accepted. We'll confirm once the customer has paid.`, deepLink: `trades-provider://bookings/${p.bookingId}` };
    case `${Events.QuoteAccepted}:loser`:
      return { title: 'Request closed', body: `The customer chose another provider for this ${cat} job.` };
    case `${Events.PaymentCaptured}:customer`:
      return { title: 'Payment confirmed', body: `${money(p, 'charged')} received for booking ${p.reference}. Funds are held securely until you approve the work.`, deepLink: `trades://bookings/${p.bookingId}` };
    case `${Events.PaymentCaptured}:provider`:
      return { title: 'Job confirmed — you can start', body: `Booking ${p.reference} is paid. Exact address is now available.`, deepLink: `trades-provider://bookings/${p.bookingId}` };
    case Events.PaymentFailed:
      return { title: 'Payment failed', body: `Your payment for ${p.reference} didn't go through. Please try again.`, deepLink: `trades://bookings/${p.bookingId}` };
    case Events.JobEnRoute:
      return { title: 'Your pro is on the way', body: `${p.providerName} is heading to you${p.etaMin ? ` · ETA ~${p.etaMin} min` : ''}.`, deepLink: `trades://bookings/${p.bookingId}` };
    case Events.JobStarted:
      return { title: 'Job started', body: `${p.providerName} has started work on ${p.reference}.`, deepLink: `trades://bookings/${p.bookingId}` };
    case Events.JobCompleted:
      return { title: 'Action needed: approve the job', body: `${p.providerName} marked ${p.reference} complete. Approve or report a problem.`, deepLink: `trades://bookings/${p.bookingId}` };
    case Events.AutoApproveReminder:
      return { title: 'Job will be auto-approved soon', body: `Booking ${p.reference} will be approved automatically in ${p.hoursLeft}h unless you report a problem.`, deepLink: `trades://bookings/${p.bookingId}` };
    case Events.JobApproved:
      return { title: 'Job approved', body: `Payout of ${money(p, 'net')} for ${p.reference} is scheduled for ${new Date(p.eligibleAt).toLocaleString('en-GB')}.`, deepLink: `trades-provider://earnings` };
    case Events.PayoutReleased:
      return { title: 'Payout sent', body: `${money(p, 'net')} for ${p.reference} has been sent to your account.`, deepLink: `trades-provider://earnings` };
    case Events.PayoutHeld:
      return { title: 'Payout on hold', body: `Your payout for ${p.reference} is on hold: ${p.reason}.`, deepLink: `trades-provider://earnings` };
    case Events.BookingCancelled:
      return { title: 'Booking cancelled', body: `Booking ${p.reference} was cancelled${p.reason ? `: ${p.reason}` : ''}.${p.refund ? ` A refund of ${p.refund} is on its way.` : ''}` };
    case Events.RefundProcessed:
      return { title: 'Refund processed', body: `${money(p)} has been refunded for ${p.reference}. It may take a few days to appear.` };
    case Events.DisputeOpened:
      return { title: 'Dispute opened', body: `A dispute was opened on ${p.reference} (${String(p.reason).replace('_', ' ')}). Our team will review it.`, deepLink: `trades://disputes/${p.disputeId}` };
    case Events.DisputeEvidenceRequested:
      return { title: 'Evidence requested', body: `Support needs more information about ${p.reference}. Please respond by ${new Date(p.dueAt).toLocaleString('en-GB')}.`, deepLink: `trades://disputes/${p.disputeId}` };
    case Events.DisputeResolved:
      return { title: 'Dispute resolved', body: `The dispute on ${p.reference} was resolved: ${String(p.resolution).replace(/_/g, ' ')}.`, deepLink: `trades://disputes/${p.disputeId}` };
    case Events.ReviewPublished:
      return { title: 'New review', body: `You received a ${p.rating}★ review.` };
    case Events.ProviderVerified:
      return { title: "You're verified!", body: 'Your account has been approved. Go online to start receiving jobs.' };
    case Events.ProviderRejected:
      return { title: 'Verification update', body: `We couldn't verify your account: ${p.reason}. Please update your documents.` };
    case Events.MessageReceived:
      return { title: p.senderName ?? 'New message', body: String(p.preview ?? '').slice(0, 120), deepLink: p.deepLink };
    default:
      return { title: 'Update', body: 'You have a new update.' };
  }
}
