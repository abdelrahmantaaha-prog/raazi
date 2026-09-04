import Discover from "./Discover";

export const dynamic = "force-dynamic";

/**
 * Chasing something today, as opposed to following it every day.
 *
 * A feed is a standing instruction and belongs on the Feeds page. This is the
 * other half of the job: a phrase you need right now, searched across Google
 * News and Bing, with the results listed so you can pull in the three that
 * matter and leave the rest. Nothing is subscribed to and nothing is kept
 * unless you say so.
 */
export default function DiscoverPage() {
  return <Discover />;
}
