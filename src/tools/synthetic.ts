export interface LabWorld {
  drawer_open: boolean;
  key_taken: boolean;
  cabinet_open: boolean;
  sample_id: string;
  badge_failures: number;
  clock_observed: boolean;
  side_panel_unlocked: boolean;
  tried_code: boolean;
  env_rev: string;
  last_error: string | null;
}

export function freshWorld(): LabWorld {
  return {
    drawer_open: false,
    key_taken: false,
    cabinet_open: false,
    sample_id: "SAMPLE-42",
    badge_failures: 0,
    clock_observed: false,
    side_panel_unlocked: false,
    tried_code: false,
    env_rev: "env-1",
    last_error: null,
  };
}

export function inspectWorld(world: LabWorld, target: string): { observation: string; subject: string; world: LabWorld } {
  switch (target) {
    case "desk":
      return { observation: "A lab desk with a sticky note, a badge reader, and a locked drawer.", subject: "desk", world };
    case "note":
      return { observation: "Sticky note reads: 'cabinet code is 0000'. This is a misleading clue.", subject: "note", world };
    case "drawer":
      return {
        observation: world.drawer_open ? "Drawer is open. A brass key sits inside." : "Drawer is locked. Badge reader is attached.",
        subject: "drawer",
        world,
      };
    case "cabinet":
      return {
        observation: world.cabinet_open
          ? `Cabinet is open. Sample ID is ${world.sample_id}.`
          : world.key_taken
            ? "Cabinet is locked. You are holding a brass key."
            : "Cabinet is locked. Keyhole is visible. No key in hand.",
        subject: "cabinet",
        world,
      };
    case "clock": {
      const next = { ...world, clock_observed: true, side_panel_unlocked: true, env_rev: "env-2" };
      return { observation: "Lab clock reads shift-change. A side panel latch clicks open.", subject: "clock", world: next };
    }
    case "side_panel":
      return {
        observation: world.side_panel_unlocked
          ? "Side panel is unlocked. Inside is a duplicate key hook (empty) and a log: 'key stored in drawer'."
          : "Side panel is sealed.",
        subject: "side_panel",
        world,
      };
    default:
      return { observation: `unknown target ${target}`, subject: target, world };
  }
}

export function actWorld(world: LabWorld, action: string, arg?: string): { observation: string; subject: string; world: LabWorld; transient?: boolean } {
  switch (action) {
    case "try_code": {
      const next = { ...world, tried_code: true };
      return { observation: `Code ${arg ?? "0000"} rejected. Cabinet remains locked.`, subject: "cabinet_code", world: next };
    }
    case "use_badge": {
      const failures = world.badge_failures + 1;
      if (failures <= 2) {
        return {
          observation: `Badge reader transient failure (${failures}/2). Retry later.`,
          subject: "badge",
          world: { ...world, badge_failures: failures, last_error: "transient" },
          transient: true,
        };
      }
      return {
        observation: "Badge accepted. Drawer latch releases.",
        subject: "badge",
        world: { ...world, badge_failures: failures, drawer_open: true, last_error: null },
      };
    }
    case "open_drawer": {
      if (!world.drawer_open) {
        return { observation: "Drawer still locked.", subject: "drawer", world };
      }
      return { observation: "Drawer already open.", subject: "drawer", world };
    }
    case "take_key": {
      if (!world.drawer_open) {
        return { observation: "Cannot take key: drawer locked.", subject: "key", world };
      }
      return { observation: "Took brass key from drawer.", subject: "key", world: { ...world, key_taken: true } };
    }
    case "open_cabinet": {
      if (!world.key_taken) {
        return { observation: "Cabinet locked: missing key precondition.", subject: "cabinet", world };
      }
      return {
        observation: `Cabinet opens. Sample ID ${world.sample_id} recovered.`,
        subject: "cabinet",
        world: { ...world, cabinet_open: true },
      };
    }
    case "open_side_panel": {
      if (!world.side_panel_unlocked) {
        return { observation: "Side panel sealed until the clock is observed.", subject: "side_panel", world };
      }
      return { observation: "Side panel opened. Log confirms key is in the drawer.", subject: "side_panel", world };
    }
    default:
      return { observation: `unknown action ${action}`, subject: "unknown", world };
  }
}

export function oracleGoalSatisfied(world: LabWorld): boolean {
  return world.cabinet_open;
}
