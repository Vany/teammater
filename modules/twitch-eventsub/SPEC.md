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
3. If both pass: get `twitch-chat` module, send `/shoutout <from_broadcaster_user_login>`
4. If chat not connected or thresholds not met: log and skip

Config stored in eventsub module panel (not twitch-chat), since raids are an EventSub concern.

## Notification Dispatch
`_handleEventSubMessage` checks `msg.payload.subscription.type` to route notifications:
- `channel.channel_points_custom_reward_redemption.add` → `_notifyRedemptionHandlers`
- `channel.raid` → `_handleRaid`

## Rewards List UI
Custom rewards are displayed in a collapsible list in the config panel with TEST buttons that simulate redemptions.
