from string import Template


NOTICE = Template("Hello $name, your plan changes on $date.")


def render(name: str, date: str) -> str:
    return NOTICE.substitute(name=name, date=date)
