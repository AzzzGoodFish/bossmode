/**
 * Product tour steps (English UI baseline).
 * Targets use data-tour="<id>" anchors on real product elements.
 */

export type TourPlace = "right" | "top" | "bottom";

export type TourPrepare =
  | "none"
  | "settings-models"
  | "rooms-panel"
  | "first-room";

export interface TourStep {
  key: string;
  title: string;
  /** Plain text paragraphs; first is lead, rest optional detail blocks. */
  paragraphs: string[];
  /** Optional structured bullet blocks after paragraphs. */
  blocks?: Array<{ heading: string; lines: string[] }>;
  primary: string;
  /** Centered card — no spotlight target. */
  center?: boolean;
  wide?: boolean;
  place?: TourPlace;
  /** data-tour attribute value on the real UI element. */
  target?: string;
  prepare?: TourPrepare;
}

export const TOUR_STEPS: TourStep[] = [
  {
    key: "welcome",
    title: "Welcome to Bossmode",
    paragraphs: [
      "Bossmode is where you run work with your member team — like a real team: roles, chat, tasks and shared memory.",
      "Two things to get started: connect a model, then create a room and chat.",
    ],
    primary: "Start tour",
    center: true,
    prepare: "none",
  },
  {
    key: "model",
    title: "1 · Connect a model",
    paragraphs: [
      "Members need a model before they can think. Open Settings → Models and connect a provider.",
    ],
    blocks: [
      {
        heading: "How",
        lines: [
          "Click Connect Provider",
          "Pick a provider",
          "Paste an API key (or browser sign-in where OAuth is offered)",
          "Fetch models → Save, then assign the model to a member",
        ],
      },
      {
        heading: "Two kinds",
        lines: [
          "Built-in — official providers (Anthropic / OpenAI / Kimi / xAI…): maintained catalog, one-click connect.",
          "Custom endpoint — any OpenAI-compatible API (company gateway, proxy, self-hosted): you fill base URL + key + model IDs.",
        ],
      },
    ],
    primary: "Next",
    wide: true,
    place: "right",
    target: "connect-provider",
    prepare: "settings-models",
  },
  {
    key: "room",
    title: "2 · Create a room",
    paragraphs: [
      "A room is your team's workspace: conversations, tasks and memory live here.",
      "Click +, pick New member — it wakes up in a DM; give it a model and it introduces itself.",
    ],
    primary: "Next",
    place: "right",
    target: "new-room",
    prepare: "rooms-panel",
  },
  {
    key: "chat",
    title: "3 · Just say it",
    paragraphs: [
      "Natural language is the interface — type what you want in plain words.",
      "Use @ to activate a specific member: @pm organize this, @developer fix that.",
    ],
    primary: "Next",
    place: "top",
    target: "composer",
    prepare: "first-room",
  },
  {
    key: "done",
    title: "You're all set",
    paragraphs: [
      "That's the whole loop: member → model → room → chat. Everything else (skills, usage stats) layers on top when you need it.",
      "Replay this tour anytime: Help (?) → Replay product tour.",
    ],
    primary: "Finish",
    center: true,
    prepare: "none",
  },
];

export const TOUR_STEP_COUNT = TOUR_STEPS.length;
