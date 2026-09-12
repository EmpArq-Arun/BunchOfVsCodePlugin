#include "IConnection.h"

enum class LinkState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting
};

class LinkManager : public IConnection, public Loggable {
public:
    void OnTick();
    LinkState GetLinkState() const { return state_; }

private:
    LinkState state_ = LinkState::Disconnected;
};

void LinkManager::OnTick() {
    if (state_ == LinkState::Disconnected) {
        if (ShouldAttemptConnect()) {
            OpenSocket();
            state_ = LinkState::Connecting;
        }
    }
    if (state_ == LinkState::Connecting) {
        if (HandshakeComplete()) {
            state_ = LinkState::Connected;
        }
    }
    if (state_ == LinkState::Connected) {
        if (LinkLost()) {
            state_ = LinkState::Reconnecting;
        }
    }
    if (state_ == LinkState::Reconnecting) {
        if (RetryTimerExpired()) {
            OpenSocket();
            state_ = LinkState::Connecting;
        }
    }
}
