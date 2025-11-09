#!/usr/bin/env python3
"""
Enhanced API Testing Script with Full Call Flow Testing
Tests: Call initiation → Status monitoring → Transcript retrieval
"""

import requests
import json
import sys
import time
from typing import Dict, Any, Optional
from datetime import datetime


# Colors for terminal output
class Colors:
    GREEN = "\033[92m"
    RED = "\033[91m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    MAGENTA = "\033[95m"
    RESET = "\033[0m"
    BOLD = "\033[1m"


def print_header(text: str):
    """Print a formatted header"""
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}{text.center(70)}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.CYAN}{'=' * 70}{Colors.RESET}\n")


def print_success(text: str):
    """Print success message"""
    print(f"{Colors.GREEN}✓ {text}{Colors.RESET}")


def print_error(text: str):
    """Print error message"""
    print(f"{Colors.RED}✗ {text}{Colors.RESET}")


def print_info(text: str):
    """Print info message"""
    print(f"{Colors.BLUE}ℹ {text}{Colors.RESET}")


def print_warning(text: str):
    """Print warning message"""
    print(f"{Colors.YELLOW}⚠ {text}{Colors.RESET}")


def print_response(response: requests.Response):
    """Pretty print HTTP response"""
    print(f"\n{Colors.BOLD}Response:{Colors.RESET}")
    print(f"  Status Code: {response.status_code}")
    try:
        print(f"  Body: {json.dumps(response.json(), indent=2)}")
    except:
        print(f"  Body: {response.text[:500]}")


def initiate_call(phone_number: str, base_url: str) -> Optional[tuple[str, str]]:
    """Initiate a call and return the (callId, conversationId)"""
    print_header("Step 1: Initiating Call")
    print_info(f"Calling {phone_number}...")
    try:
        response = requests.post(
            f"{base_url}/call", json={"phoneNumber": phone_number}, timeout=10
        )
        print_response(response)
        if response.status_code == 200:
            data = response.json()
            call_id = data.get("callId")
            conversation_id = data.get("conversationId")
            print_success(f"Call initiated!")
            print_info(f"Call ID: {call_id}")
            print_info(f"Conversation ID: {conversation_id}")
            return (call_id, conversation_id)
        else:
            print_error(f"Failed to initiate call: {response.status_code}")
            return None

    except Exception as e:
        print_error(f"Error: {str(e)}")
        return None


def get_call_status(call_sid: str, base_url: str) -> Optional[Dict[str, Any]]:
    """Get the status of a call"""
    try:
        response = requests.get(f"{base_url}/call/{call_sid}/status", timeout=10)

        if response.status_code == 200:
            return response.json()
        else:
            print_error(f"Failed to get status: {response.status_code}")
            return None

    except Exception as e:
        print_error(f"Error: {str(e)}")
        return None


def monitor_call(call_sid: str, base_url: str, max_wait_seconds: int = 300) -> bool:
    """Monitor call status until it completes"""
    print_header("Step 2: Monitoring Call Status")
    print_info(f"Monitoring call {call_sid}...")
    print_info(f"Max wait time: {max_wait_seconds} seconds")

    start_time = time.time()
    last_status = None

    while time.time() - start_time < max_wait_seconds:
        status_data = get_call_status(call_sid, base_url)

        if status_data:
            current_status = status_data.get("status")

            # Only print if status changed
            if current_status != last_status:
                elapsed = int(time.time() - start_time)
                print(
                    f"\n{Colors.MAGENTA}[{elapsed}s]{Colors.RESET} Status: {current_status}"
                )

                if current_status == "completed":
                    duration = status_data.get("duration", "N/A")
                    print_success(f"Call completed! Duration: {duration} seconds")
                    return True
                elif current_status == "failed":
                    print_error("Call failed!")
                    print(f"Details: {json.dumps(status_data, indent=2)}")
                    return False
                elif current_status == "busy":
                    print_warning("Number is busy")
                    return False
                elif current_status == "no-answer":
                    print_warning("No answer")
                    return False

                last_status = current_status

        time.sleep(5)  # Check every 5 seconds

    print_warning(f"Timeout after {max_wait_seconds} seconds")
    return False


def list_conversations(base_url: str) -> Optional[list]:
    """List all recent conversations"""
    print_header("Step 3a: Listing Recent Conversations")
    print_info("Fetching conversation list from ElevenLabs...")

    try:
        response = requests.get(f"{base_url}/conversations", timeout=10)
        print_response(response)

        if response.status_code == 200:
            data = response.json()
            conversations = data.get("conversations", [])
            print_success(f"Found {len(conversations)} conversations")
            return conversations
        else:
            print_error(f"Failed to list conversations: {response.status_code}")
            return None

    except Exception as e:
        print_error(f"Error: {str(e)}")
        return None


def get_transcript(conversation_id: str, base_url: str) -> bool:
    """Retrieve transcript for a conversation"""
    print_header("Step 3b: Retrieving Transcript")
    print_info(f"Fetching transcript for conversation {conversation_id}...")

    try:
        response = requests.get(
            f"{base_url}/conversation/{conversation_id}/transcript", timeout=10
        )
        print_response(response)

        if response.status_code == 200:
            data = response.json()
            transcript = data.get("transcript", [])
            metadata = data.get("metadata", {})

            print_success("Transcript retrieved!")
            print(f"\n{Colors.BOLD}Metadata:{Colors.RESET}")
            print(f"  Duration: {metadata.get('duration', 'N/A')} seconds")
            print(f"  Agent ID: {metadata.get('agentId', 'N/A')}")

            if transcript:
                print(
                    f"\n{Colors.BOLD}Transcript ({len(transcript)} messages):{Colors.RESET}"
                )
                for i, message in enumerate(transcript, 1):
                    role = message.get("role", "unknown")
                    text = message.get("message", "")
                    timestamp = message.get("timestamp", "N/A")
                    print(f"\n  {i}. [{role.upper()}] {text}")
                    if timestamp != "N/A":
                        print(f"     Time: {timestamp}")
            else:
                print_warning("No transcript messages found")

            return True
        else:
            print_error(f"Failed to get transcript: {response.status_code}")
            return False

    except Exception as e:
        print_error(f"Error: {str(e)}")
        return False


def test_chat_session(base_url: str) -> Optional[str]:
    """Test creating a chat session"""
    print_header("Step 4a: Creating Chat Session")

    try:
        response = requests.post(f"{base_url}/chat/session", json={}, timeout=10)
        print_response(response)

        if response.status_code == 200:
            data = response.json()
            session_id = data.get("sessionId")
            user_id = data.get("userId")

            if session_id and user_id:
                print_success(f"Chat session created!")
                print_info(f"User ID: {user_id}")
                print_info(f"Session ID: {session_id}")
                return (user_id, session_id)
            else:
                print_error("Response missing sessionId or userId")
                return None
        else:
            print_error(f"Failed to create session: {response.status_code}")
            return None

    except Exception as e:
        print_error(f"Error creating chat session: {str(e)}")
        return None


def test_chat_message(base_url: str, user_id: str, session_id: str) -> bool:
    """Test sending a chat message"""
    print_header("Step 4b: Sending Chat Message")

    message = "Hi there, I need help finding a youth shelter in Sacramento."

    try:
        payload = {"userId": user_id, "sessionId": session_id, "message": message}
        response = requests.post(f"{base_url}/chat/message", json=payload, timeout=30)
        print_response(response)

        if response.status_code == 200:
            data = response.json()
            reply = data.get("reply")

            if reply:
                print_success("Received AI reply!")
                print(f"\n{Colors.BOLD}Agent:{Colors.RESET} {reply}")
                return True
            else:
                print_warning("No reply text found in response.")
                return False
        else:
            print_error(f"Chat message request failed: {response.status_code}")
            return False

    except Exception as e:
        print_error(f"Error sending chat message: {str(e)}")
        return False


def test_full_flow(
    phone_number: str,
    base_url: str,
    actually_call: bool = False,
    skip_calling: bool = False,
) -> int:
    """Test the complete flow: call → monitor → transcript"""
    print(f"\n{Colors.BOLD}{Colors.BLUE}")
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║              Full Call Flow Test - Starting                      ║")
    print("╚═══════════════════════════════════════════════════════════════════╝")
    print(f"{Colors.RESET}")

    print_info(f"Base URL: {base_url}")
    print_info(f"Phone Number: {phone_number}")
    print_info(f"Timestamp: {datetime.now().isoformat()}")

    # Step 4 only: skip all call-related tests
    if skip_calling:
        print_header("Skipping Call Flow (--skip_calling)")
        print_info("Running chat session and message tests only...\n")

        chat_info = test_chat_session(base_url)
        if chat_info:
            user_id, session_id = chat_info
            test_chat_message(base_url, user_id, session_id)
            print_success("Chat test completed successfully (no calls made)")
            return 0
        else:
            print_error("Chat test failed: could not create chat session")
            return 1

    if not actually_call:
        print_warning("\nNot making actual call (use --actually-call flag)")
        print_info("Testing conversation list and transcript retrieval only...\n")

        # Test listing conversations
        conversations = list_conversations(base_url)

        if conversations and len(conversations) > 0:
            # Get the most recent conversation
            latest = conversations[0]
            conversation_id = latest.get("conversation_id")

            if conversation_id:
                print_info(f"\nUsing most recent conversation: {conversation_id}")
                get_transcript(conversation_id, base_url)
            else:
                print_warning("No conversation ID found in latest conversation")
        else:
            print_warning("No conversations found. Make a test call first!")

        return 0

    # Full flow test
    print_warning(f"\n!!! *** This will make an actual call to {phone_number}")
    print("Press Enter to proceed or Ctrl+C to cancel...")
    try:
        input()
    except KeyboardInterrupt:
        print_info("\nTest cancelled")
        return 0

    # Step 1: Initiate call
    result = initiate_call(phone_number, base_url)
    if not result:
        print_error("Failed to initiate call. Aborting.")
        return 1

    call_id, conversation_id = result
    # Step 2: Wait for call to complete (you won't be able to monitor status with ElevenLabs)
    print_info(f"\nWaiting 60 seconds for call id {call_id} to complete...")
    time.sleep(30)
    # Step 3: Get transcript directly using the conversation_id
    success = get_transcript(conversation_id, base_url)
    if success:
        print_header("Full Flow Test Complete!")
        print_success("Successfully tested: Call → Transcript")
    else:
        print_error("Could not retrieve transcript")
        print_info("The conversation may still be processing. Try again in a minute.")
        print_info(f"Or manually check: GET {base_url}/conversations")
    # Step 4: Chat session and message testing
    print_header("Step 4: Testing Chat Endpoints (/chat/session and /chat/message)")
    chat_info = test_chat_session(base_url)
    if chat_info:
        user_id, session_id = chat_info
        test_chat_message(base_url, user_id, session_id)
        return 0
    else:
        print_error("Chat message test because session creation failed")

    return 1


def main():
    """Main entry point"""
    import argparse

    parser = argparse.ArgumentParser(
        description="Test full call flow with transcript retrieval",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # List conversations and get latest transcript (no call)
  python test_flow.py
  
  # Make actual call and get full flow
  python test_flow.py --phone +1234567890 --actually-call
  
  # Use custom server URL
  python test_flow.py --url https://your-ngrok-url.ngrok.io --actually-call
        """,
    )
    parser.add_argument(
        "--url",
        default="http://localhost:8080",
        help="Base URL of the API (default: http://localhost:8080)",
    )
    parser.add_argument(
        "--phone",
        default="+1234567890",
        help="Phone number to call (default: +1234567890)",
    )
    parser.add_argument(
        "--actually-call", action="store_true", help="Actually make a phone call"
    )
    parser.add_argument(
        "--skip-calling",
        action="store_true",
        help="Skip all call-related tests and only test chat endpoints",
    )
    args = parser.parse_args()

    # Run test
    exit_code = test_full_flow(
        args.phone, args.url.rstrip("/"), args.actually_call, args.skip_calling
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
