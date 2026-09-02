# Twitch EventSub Module — Spec

## Overview
WebSocket connection to Twitch EventSub. Handles channel events: channel point redemptions and incoming raids.

## Subscriptions

### channel.channel_points_custom_reward_redemption.add
- Condition: `broadcaster_user_id = currentUserId`
- Fires when a viewer redeems a custom channel point reward
- Dispatches to registered `redemptionHandlers`

### channel.raid
- Condition: `to_broadcaster_user_id = currentUserId`
- Fires when another broadcaster raids our channel
- Handled internally by `_handleRaid(event)`

## Auto Shoutout on Raid

When a raid arrives:
1. Check `auto_shoutout.enabled` (checkbox, default: true)
2. Check `event.viewers >= auto_shoutout.min_raiders` (number, default: 5)
3. If both pass: get the **`obs`** module and call `_twitchShoutout(from_broadcaster_user_login)`,
   which POSTs to Helix `/helix/chat/shoutouts`. It is NOT an IRC `/shoutout`
   command and does NOT go through `twitch-chat` — no PRIVMSG is ever sent for a
   raid. (This said "send /shoutout via twitch-chat" until 2026-09-01, which sent
   anyone debugging a missing shoutout to watch an IRC socket that carries
   nothing, and hid the real dependencies: the OBS module being present and
   connected, and the `moderator:manage:shoutouts` scope.)
4. If the OBS module is unavailable or thresholds are not met: log and skip

Config stored in eventsub module panel (not twitch-chat), since raids are an EventSub concern.

## Notification Dispatch
`_handleEventSubMessage` checks `msg.payload.subscription.type` to route notifications:
- `channel.channel_points_custom_reward_redemption.add` → `_notifyRedemptionHandlers`
- `channel.raid` → `_handleRaid`

## Rewards List UI
Custom rewards are displayed in a collapsible list in the config panel with TEST buttons that simulate redemptions.
