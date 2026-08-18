// All monetary values are handled in integer CENTS everywhere on the server.
// The client never computes or is trusted with fees, dredits, or costs —
// it only ever displays numbers the server already calculated.

const FEE_RATE = 0.02; // Donaro's 2% developer fee
const CREATOR_NUMERATOR = 10000; // 100 / 102, kept as an integer ratio
const CREATOR_DENOMINATOR = 10200;

const GOAL_CREATION_COST_DREDITS = 90;
const AD_MIN_DAYS = 5;
const AD_DREDITS_PER_DAY = 100;
const AD_APPEARANCES_PER_DREDIT = 2;
const NOTE_MIN_CENTS = 10000; // $100.00, inclusive

function dollarsToCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InputError('Amount must be a positive number.');
  }
  // round to avoid floating point artifacts, then floor any sub-cent value
  return Math.round(n * 100);
}

function centsToDollarsString(cents) {
  return (cents / 100).toFixed(2);
}

// requested amount -> total goal (creator's ask is 100%, goal target is 102%)
function computeGoalTotal(requestedCents) {
  return Math.round(requestedCents * (1 + FEE_RATE));
}

// Split an incoming donation between creator and Donaro's fee, pooled/prorated
// at exactly 100/102, so that once a goal is fully funded to its 102% total,
// the creator has received exactly the requested 100% (any rounding remainder
// lands with Donaro's fee share, never with the creator).
function splitDonation(amountCents) {
  const creatorShare = Math.round(amountCents * (CREATOR_NUMERATOR / CREATOR_DENOMINATOR));
  const feeShare = amountCents - creatorShare;
  return { creatorShare, feeShare };
}

// Dredits = floor(donation dollars / 2), i.e. floor(cents / 200)
function computeDredits(amountCents) {
  return Math.floor(amountCents / 200);
}

function noteAllowed(amountCents) {
  return amountCents >= NOTE_MIN_CENTS;
}

function computeAdCost(days) {
  if (!Number.isInteger(days) || days < AD_MIN_DAYS) {
    throw new InputError(`Ads must run for at least ${AD_MIN_DAYS} days.`);
  }
  const dreditCost = days * AD_DREDITS_PER_DAY;
  const appearances = dreditCost * AD_APPEARANCES_PER_DREDIT;
  return { dreditCost, appearances };
}

class InputError extends Error {}

module.exports = {
  FEE_RATE,
  GOAL_CREATION_COST_DREDITS,
  AD_MIN_DAYS,
  AD_DREDITS_PER_DAY,
  AD_APPEARANCES_PER_DREDIT,
  NOTE_MIN_CENTS,
  dollarsToCents,
  centsToDollarsString,
  computeGoalTotal,
  splitDonation,
  computeDredits,
  noteAllowed,
  computeAdCost,
  InputError,
};
