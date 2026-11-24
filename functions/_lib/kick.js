// After a new submission or feedback item is stored, ask the timer Worker (service binding
// TIMER, no public address) to start the gateway now instead of at its next 10-minute tick.
// It never delays or changes the response: it runs in waitUntil and every failure is dropped.
// GitHub runs one gateway at a time and folds extra requests together, and the gateway asks
// for a review at most once in 15 minutes, so a burst of submissions costs one run.
export function kickGateway(context) {
  try {
    const timer = context.env && context.env.TIMER;
    if (!timer || typeof timer.fetch !== "function") return;
    context.waitUntil(Promise.resolve()
      .then(() => timer.fetch("https://timer.internal/kick", { method: "POST" }))
      .catch(() => {}));
  } catch {
    // The receipt matters more than the poke.
  }
}
