//! Exclusive native input ownership; message ordering comes from the TS runtime.
use std::collections::VecDeque;

#[derive(Clone, Copy, PartialEq)]
pub enum TurnState { Running, Done, Other, Missing }
struct Slot { request: String, persona: String, ready: bool, joined_at: u64 }
#[derive(Default)]
pub struct Queue { pub paused: bool, slots: VecDeque<Slot>, batches: VecDeque<String> }
impl Queue {
    pub fn request(&mut self, request: &str, order: &[String], persona: &str, now: u64) -> Result<(), String> {
        if !self.batches.iter().any(|id| id == request) {
            if self.slots.len() + order.len() > 64 { return Err("Browser queue is full".into()); }
            self.batches.push_back(request.into());
            // ponytail: retain the last 256 message IDs; runtime completion also rejects stale requests.
            if self.batches.len() > 256 { self.batches.pop_front(); }
            for name in order {
                if !self.slots.iter().any(|s| s.request == request && s.persona == *name) {
                    self.slots.push_back(Slot { request: request.into(), persona: name.clone(), ready: false, joined_at: now });
                }
            }
        }
        let slot = self.slots.iter_mut().find(|s| s.request == request && s.persona == persona).ok_or("This browser turn has finished")?;
        slot.ready = true;
        Ok(())
    }
    pub fn refresh(&mut self, now: u64, state: impl Fn(&str, &str) -> TurnState) {
        self.slots.retain(|slot| match state(&slot.persona, &slot.request) {
            TurnState::Running => true,
            TurnState::Done | TurnState::Missing => false,
            // An addressed agent may still be starting its turn. Do not let an
            // agent that never joins block the browser indefinitely.
            TurnState::Other => !slot.ready && now.saturating_sub(slot.joined_at) < 120_000,
        });
    }
    pub fn driver(&self) -> Option<&str> {
        if self.paused { None } else { self.slots.front().filter(|s| s.ready).map(|s| s.persona.as_str()) }
    }
    pub fn waiting(&self) -> Vec<&str> {
        self.waiting_entries().into_iter().map(|(_, persona)| persona).collect()
    }
    pub fn waiting_entries(&self) -> Vec<(&str, &str)> {
        self.slots.iter().skip(usize::from(self.driver().is_some())).map(|s| (s.request.as_str(), s.persona.as_str())).collect()
    }
    pub fn cancel(&mut self, request: &str, persona: &str) -> Result<(), String> {
        let index = self.slots.iter().position(|s| s.request == request && s.persona == persona).ok_or("This browser turn has finished")?;
        if index == 0 && self.driver().is_some() { return Err("Only waiting browser turns can be cancelled; take control to interrupt the driver".into()); }
        self.slots.remove(index);
        Ok(())
    }
    pub fn is_empty(&self) -> bool { self.slots.is_empty() }
    pub fn clear(&mut self) { self.slots.clear(); self.paused = true; }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_a_waiter_keeps_the_driver_and_cannot_be_undone_by_polling() {
        let mut q = Queue::default();
        let order = vec!["quill".into(), "drift".into()];
        q.request("message", &order, "quill", 0).unwrap();
        q.request("message", &order, "drift", 1).unwrap();
        assert!(q.cancel("message", "quill").is_err());
        q.cancel("message", "drift").unwrap();
        assert_eq!(q.driver(), Some("quill"));
        assert!(q.waiting().is_empty());
        assert!(q.request("message", &order, "drift", 2).is_err());
        q.request("next", &["drift".into()], "drift", 3).unwrap();
        assert_eq!(q.waiting(), ["drift"]);
        q.paused = true;
        q.cancel("message", "quill").unwrap();
        q.paused = false;
        assert_eq!(q.driver(), Some("drift"));
    }
    #[test]
    fn later_request_reserves_earlier_driver_and_takeover_blocks_everyone() {
        let mut q = Queue::default();
        let order = vec!["quill".into(), "drift".into()];
        q.request("message", &order, "drift", 0).unwrap();
        assert_eq!(q.driver(), None);
        assert_eq!(q.waiting(), ["quill", "drift"]);
        q.request("message", &order, "quill", 1).unwrap();
        assert_eq!(q.driver(), Some("quill"));
        assert_eq!(q.waiting(), ["drift"]);
        q.paused = true;
        q.refresh(2, |p, _| if p == "quill" { TurnState::Done } else { TurnState::Running });
        q.request("message", &order, "drift", 3).unwrap();
        assert_eq!(q.driver(), None);
        q.paused = false;
        assert_eq!(q.driver(), Some("drift"));
        assert!(q.request("message", &order, "quill", 4).is_err());
        q.refresh(5, |_, _| TurnState::Missing);
        assert!(q.is_empty());
    }
    #[test]
    fn no_browser_use_and_missing_turns_do_not_stall_the_queue() {
        let mut q = Queue::default();
        q.request("m", &["quill".into(), "drift".into()], "drift", 0).unwrap();
        q.refresh(1, |p, _| if p == "quill" { TurnState::Done } else { TurnState::Running });
        assert_eq!(q.driver(), Some("drift"));
        q.refresh(2, |_, _| TurnState::Other);
        assert!(q.is_empty());
        q.request("next", &["quill".into(), "drift".into()], "drift", 3).unwrap();
        q.refresh(120_003, |p, _| if p == "quill" { TurnState::Other } else { TurnState::Running });
        assert_eq!(q.driver(), Some("drift"));
    }
}
