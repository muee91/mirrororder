import { expect,it } from 'vitest';
import { timecode,parseTimecode } from './timelineTimecode';
import { timecode as syncTimecode } from './syncTimelineNavigation';
it('uses one non-drop formatter for both modes with true project nominal rate',()=>{expect(syncTimecode).toBe(timecode);expect(timecode(300,{numerator:30,denominator:1})).toBe('00:00:10:00');expect(timecode(300,{numerator:50,denominator:1})).toBe('00:00:06:00');for(const rate of [{numerator:30000,denominator:1001},{numerator:60000,denominator:1001}]){const label=timecode(108000,rate);expect(label).not.toContain(';');expect(parseTimecode(label,rate)).toBe(108000);}});
