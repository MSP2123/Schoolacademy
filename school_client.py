"""
school.academy.com.ua data extractor - prototype

Logs in, then pulls:
  - Daybook (weekly schedule, grades, homework, comments)
  - Feed (notifications / recent activity)

Usage:
    python school_client.py

You'll be prompted for email/password (not hardcoded, not saved to disk).
"""

import re
import sys
import time
import getpass
import requests

BASE_URL = "https://school.academy.com.ua"
LOGIN_PAGE_URL = f"{BASE_URL}/login"   # page that contains the login form + CSRF token
AUTH_URL = f"{BASE_URL}/auth"
DAYBOOK_URL_TMPL = BASE_URL + "/daybook/get/{student_id}/{class_id}"
FEED_URL_TMPL = BASE_URL + "/feed/get/{page}"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class SchoolClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})

    def _extract_csrf_token(self, html: str) -> str:
        """
        Pull the hidden _token field out of the login page HTML.
        Tries a couple common patterns since we haven't seen the raw HTML yet -
        adjust the regex if this fails on your first run.
        """
        patterns = [
            r'name="_token"\s+value="([^"]+)"',
            r'name="_token"\s+content="([^"]+)"',
            r'<meta name="csrf-token" content="([^"]+)"',
        ]
        for pattern in patterns:
            match = re.search(pattern, html)
            if match:
                return match.group(1)
        raise RuntimeError(
            "Could not find CSRF token in login page HTML. "
            "The page structure may differ from what we assumed - "
            "save the HTML and inspect it manually."
        )

    def login(self, email: str, password: str, remember: bool = True) -> None:
        # Step 1: load the login page to get a fresh CSRF token + cookies
        resp = self.session.get(LOGIN_PAGE_URL)
        resp.raise_for_status()
        token = self._extract_csrf_token(resp.text)

        # Step 2: submit credentials
        payload = {
            "_token": token,
            "email": email,
            "password": password,
            "remember": "on" if remember else "",
            "login": "",
        }
        resp = self.session.post(AUTH_URL, data=payload, allow_redirects=True)
        resp.raise_for_status()

        # Sanity check: did we actually get a session cookie?
        if "a_school_session" not in self.session.cookies.get_dict():
            raise RuntimeError(
                "Login likely failed - no session cookie received. "
                "Check credentials, or the site may require a different flow now."
            )

        print("Logged in successfully.")

    def get_daybook_week(self, student_id: int, class_id: int, timestamp: int = None) -> dict:
        """Fetch one week of schedule/grades. timestamp defaults to 'now'."""
        if timestamp is None:
            timestamp = int(time.time() * 1000)
        url = DAYBOOK_URL_TMPL.format(student_id=student_id, class_id=class_id)
        resp = self.session.get(url, params={"timestamp": timestamp})
        resp.raise_for_status()
        return resp.json()

    def get_feed(self, page: int = 1, timestamp: int = None) -> dict:
        """Fetch a page of the notifications/comments feed."""
        if timestamp is None:
            timestamp = int(time.time() * 1000)
        url = FEED_URL_TMPL.format(page=page)
        resp = self.session.get(url, params={"timestamp": timestamp})
        resp.raise_for_status()
        return resp.json()


def print_grades_summary(daybook_json: dict) -> None:
    """Pretty-print grades found in a daybook response."""
    week_days = daybook_json.get("data", {}).get("week_days") or daybook_json.get("week_days", [])
    for day in week_days:
        day_name = day.get("day_name", "?")
        date = day.get("date", "?")
        lessons_with_grades = [l for l in day.get("lessons", []) if l.get("grades")]
        if not lessons_with_grades:
            continue
        print(f"\n{day_name} ({date})")
        for lesson in lessons_with_grades:
            subject = lesson.get("subject_name", "?")
            for grade in lesson["grades"]:
                value = grade.get("grade_value", "?")
                gtype = grade.get("grade_type_name", "")
                comment = grade.get("comment", "")
                line = f"  {subject}: {value}"
                if gtype:
                    line += f" ({gtype})"
                if comment:
                    line += f" - {comment}"
                print(line)


def main():
    email = input("Email: ").strip()
    password = getpass.getpass("Password: ")

    client = SchoolClient()
    try:
        client.login(email, password)
    except Exception as e:
        print(f"Login failed: {e}", file=sys.stderr)
        sys.exit(1)

    # NOTE: student_id and class_id are hardcoded from what we saw in your
    # DevTools session (2556 / 41). If this errors out, they may be
    # session-specific or need to be discovered from another endpoint -
    # let's debug that together if it happens.
    student_id = 2556
    class_id = 41

    print("\nFetching daybook...")
    daybook = client.get_daybook_week(student_id, class_id)
    print_grades_summary(daybook)

    print("\nFetching feed...")
    feed = client.get_feed(page=1)
    items = feed.get("data", {}).get("items", [])
    print(f"\n{len(items)} recent feed items:")
    for item in items[:10]:
        print(f"  [{item.get('time_formatted')}] {item.get('title')}")


if __name__ == "__main__":
    main()
