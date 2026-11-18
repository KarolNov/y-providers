## Purpose

Tabs of one browser that open the same document converge without a reload.

## Requirements

### Requirement: Live sync between tabs

Tabs that open the same document SHALL converge without a reload, including updates a tab applies from another source such as a network provider.

- **Scenario: Edit in one tab**
  - **GIVEN** two tabs with the document open
  - **WHEN** one tab edits it
  - **THEN** the other tab shows the edit without reloading

### Requirement: Catch up after a missed message

A tab that misses a broadcast, or receives one too large to send whole (over 256 KB), SHALL re-read storage and catch up.

- **Scenario: Dropped broadcast**
  - **WHEN** a broadcast to the second tab is lost and the first tab writes again
  - **THEN** the second tab re-reads storage and holds both edits

### Requirement: Clear reaches every tab

Clearing data in one tab SHALL tell the other open tabs, which detach from the cleared document.

- **Scenario: Clear in one of two tabs**
  - **WHEN** one tab clears the data
  - **THEN** the other tab detaches and does not write the old document back
