const PEAK_START_HOUR = 14;
const PEAK_END_HOUR = 18;
const CHINA_OFFSET_HOURS = 8;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

// DeepSeek peak windows in UTC, Monday through Friday (Chinese holidays ignored).
const DEEPSEEK_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];
const DEEPSEEK_BOUNDARY_HOURS = [1, 4, 6, 10];

export interface PeakHoursStatus {
  inPeakHours: boolean;
  timeUntilTransition: string;
  transitionType: 'start' | 'end';
}

function getChinaTime(): Date {
  const now = new Date();
  const str = now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' });
  return new Date(str);
}

function formatDuration(diffMs: number): string {
  const hours = Math.floor(diffMs / MS_PER_HOUR);
  const minutes = Math.floor((diffMs % MS_PER_HOUR) / MS_PER_MINUTE);

  if (hours > 0 && minutes > 0) {
    return `${hours} hours ${minutes} minutes`;
  }
  if (hours > 0) {
    return `${hours} hours`;
  }
  return `${minutes} minutes`;
}

export function getPeakHoursStatus(): PeakHoursStatus {
  const chinaTime = getChinaTime();
  const currentHour = chinaTime.getHours();

  let inPeakHours: boolean;
  let transitionTime: Date;
  let transitionType: 'start' | 'end';

  if (currentHour >= PEAK_START_HOUR && currentHour < PEAK_END_HOUR) {
    inPeakHours = true;
    transitionType = 'end';
    transitionTime = new Date(chinaTime);
    transitionTime.setHours(PEAK_END_HOUR, 0, 0, 0);
  } else {
    inPeakHours = false;
    transitionType = 'start';

    let transitionDay = new Date(chinaTime);
    if (currentHour >= PEAK_END_HOUR) {
      transitionDay.setDate(transitionDay.getDate() + 1);
    }

    transitionDay.setHours(PEAK_START_HOUR, 0, 0, 0);
    transitionTime = transitionDay;
  }

  const diffMs = transitionTime.getTime() - chinaTime.getTime();

  return {
    inPeakHours,
    timeUntilTransition: formatDuration(diffMs),
    transitionType
  };
}

function formatGMTOffset(): string {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const offsetHours = Math.abs(Math.floor(offsetMinutes / 60));
  const offsetMinutesRemainder = Math.abs(offsetMinutes % 60);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  return `GMT${sign}${offsetHours}${offsetMinutesRemainder > 0 ? ':' + String(offsetMinutesRemainder).padStart(2, '0') : ''}`;
}

function formatLocalTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function getPeakHoursRange(): string {
  const now = new Date();

  const startUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0));
  const endUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0));

  const startTime = formatLocalTime(startUTC);
  const endTime = formatLocalTime(endUTC);

  return `${startTime} - ${endTime}`;
}

function isDeepSeekPeak(date: Date): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) {
    return false;
  }

  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return DEEPSEEK_PEAK_WINDOWS.some(([start, end]) => minutes >= start * 60 && minutes < end * 60);
}

export function getDeepSeekPeakHoursStatus(): PeakHoursStatus {
  const now = new Date();

  const inPeakHours = isDeepSeekPeak(now);
  let transitionTime = now;

  outer: for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    for (const hour of DEEPSEEK_BOUNDARY_HOURS) {
      const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour));

      if (candidate.getTime() <= now.getTime()) {
        continue;
      }

      if (isDeepSeekPeak(new Date(candidate.getTime() - 1)) !== isDeepSeekPeak(candidate)) {
        transitionTime = candidate;
        break outer;
      }
    }
  }

  return {
    inPeakHours,
    timeUntilTransition: formatDuration(transitionTime.getTime() - now.getTime()),
    transitionType: inPeakHours ? 'end' : 'start'
  };
}

function getDeepSeekPeakHoursRanges(): string {
  return DEEPSEEK_PEAK_WINDOWS.map(([start, end]) => {
    const startTime = formatLocalTime(new Date(Date.UTC(2024, 0, 1, start, 0, 0)));
    const endTime = formatLocalTime(new Date(Date.UTC(2024, 0, 1, end, 0, 0)));
    return `${startTime} - ${endTime}`;
  }).join(', ');
}

export function formatPeakHoursMessage(status: PeakHoursStatus): string {
  const offset = formatGMTOffset();
  const currentTime = formatLocalTime(new Date());

  const zaiIcon = status.inPeakHours ? '🔴' : '✅';
  const zaiPeakHoursText = status.inPeakHours ? 'peak' : 'off-peak';
  const zaiPeakHours = getPeakHoursRange();

  const deepseekStatus = getDeepSeekPeakHoursStatus();
  const deepseekIcon = deepseekStatus.inPeakHours ? '🔴' : '✅';
  const deepseekPeakHoursText = deepseekStatus.inPeakHours ? 'peak' : 'off-peak';
  const deepseekPeakHours = getDeepSeekPeakHoursRanges();

  return `${zaiIcon} Currently in z.ai ${zaiPeakHoursText} hours.\n${status.timeUntilTransition} remaining.\n\n${deepseekIcon} Currently in DeepSeek ${deepseekPeakHoursText} hours.\n${deepseekStatus.timeUntilTransition} remaining.\n\nCurrent time: ${currentTime} (${offset})\nz.ai peak hours:      ${zaiPeakHours} (${offset})\nDeepSeek peak hours:  ${deepseekPeakHours} (${offset})`;
}
