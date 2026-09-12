import { listCalendar } from "@/lib/calendar";
import { CalendarView } from "./CalendarView";

export const dynamic = "force-dynamic";

/**
 * The watching calendar: every date the sources have mentioned, past and
 * to come, filed as precisely as the source allowed and no more.
 *
 * Built from the events extraction already records, so nothing here is a
 * model's summary — each line opens the entity it belongs to and the source
 * that dated it. The brief files dates as it is prepared; the button on this
 * page files them for a window the brief never covered.
 */
export default function CalendarPage() {
  return <CalendarView initial={listCalendar()} />;
}
