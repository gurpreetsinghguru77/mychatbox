/**
 * Smart Reply Timing Engine
 * Decides when the AI should reply based on user behavior, time of day, and context.
 */

// Configuration Defaults
const QUIET_HOURS = {
  startHour: 23, // 11:00 PM
  endHour: 7,    // 7:00 AM
};

// Words that indicate high urgency
const URGENT_KEYWORDS = [
  'urgent', 'quickly', 'jaldi', 'fast', 'emergency', 'help', 'call',
  'important', 'important note', 'turant', 'abho', 'abhi', 'please reply'
];

/**
 * Checks if the current time falls within Quiet Hours (sleeping hours)
 * @param {Date} date 
 * @returns {boolean}
 */
function isQuietHours(date = new Date()) {
  const hours = date.getHours();
  if (QUIET_HOURS.startHour > QUIET_HOURS.endHour) {
    // Overlap midnight (e.g., 23 to 7)
    return hours >= QUIET_HOURS.startHour || hours < QUIET_HOURS.endHour;
  } else {
    // Normal range (e.g., 1 to 5)
    return hours >= QUIET_HOURS.startHour && hours < QUIET_HOURS.endHour;
  }
}

/**
 * Calculates a dynamic human-like delay (in milliseconds)
 * @param {string} text - Message text
 * @param {Date} date - Current date
 * @returns {object} { delayMs, shouldPostpone, reason }
 */
function getSmartDelay(text = '', date = new Date(), isPersonalMode = false) {
  // [PERSONAL AI MODE]: Return 1-2 second delay immediately for personal assistant use
  if (isPersonalMode) {
    return {
      delayMs: 2000,
      shouldPostpone: false,
      reason: 'Personal AI mode enabled (Fast reply)'
    };
  }

  const isQuiet = isQuietHours(date);
  const textLower = text.toLowerCase();
  
  // 1. Check if it's urgent
  const isUrgent = URGENT_KEYWORDS.some(keyword => textLower.includes(keyword));

  // 2. Base delay calculation: 
  // We want to simulate reading + typing speed.
  // Average typing speed: ~40 WPM. Reading speed: ~200 WPM.
  const wordCount = text.split(/\s+/).length || 1;
  const readDelayMs = Math.min((wordCount / 200) * 60 * 1000, 5000); // Max 5s reading time
  const typeDelayMs = Math.min((wordCount / 40) * 60 * 1000, 15000);  // Max 15s typing time
  
  let baseDelay = readDelayMs + typeDelayMs + 3000; // +3s thinking time
  
  // Enforce sensible bounds (between 8 and 35 seconds for normal conversation)
  if (baseDelay < 8000) baseDelay = 8000 + Math.random() * 4000;
  if (baseDelay > 35000) baseDelay = 35000 - Math.random() * 5000;

  // 3. Adjust for Quiet Hours
  if (isQuiet && !isUrgent) {
    // Calculate ms until end of quiet hours (7:00 AM)
    const nextMorning = new Date(date);
    nextMorning.setHours(QUIET_HOURS.endHour, 0, 0, 0);
    if (date.getHours() >= QUIET_HOURS.startHour) {
      // It's before midnight, push to next day morning
      nextMorning.setDate(nextMorning.getDate() + 1);
    }
    
    // Add a bit of random offset to morning reply so it doesn't fire exactly at 7:00:00 AM
    const offsetMs = (Math.random() * 30 + 15) * 60 * 1000; // 15-45 minutes random delay in morning
    const delayMs = (nextMorning.getTime() - date.getTime()) + offsetMs;
    
    return {
      delayMs,
      shouldPostpone: true,
      reason: `Quiet hours active (${QUIET_HOURS.startHour}h to ${QUIET_HOURS.endHour}h). Postponed until morning.`
    };
  }

  // 4. Adjust for Urgency
  if (isUrgent) {
    const fastDelay = Math.max(3000, baseDelay * 0.3); // Speed up significantly
    return {
      delayMs: fastDelay,
      shouldPostpone: false,
      reason: 'Urgent keywords detected, responding quickly.'
    };
  }

  // 5. Default natural speed
  return {
    delayMs: baseDelay,
    shouldPostpone: false,
    reason: 'Standard conversational typing delay.'
  };
}

export {
  isQuietHours,
  getSmartDelay,
  QUIET_HOURS
};
