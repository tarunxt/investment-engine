"""Project dated, consolidated statement rows into the screen's financial columns."""
import math
from datetime import datetime
from functools import lru_cache
from statistics import mean


def number(value):
    try:
        n = float(str(value).strip().replace(",", "").removesuffix("%"))
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def sheet(root, section):
    tables = root.xpath('//section[@id=$section]//table[thead and tbody]', section=section)
    if not tables:
        return {}
    table = tables[0]
    headers = [x.text_content().strip() for x in table.xpath('./thead/tr[last()]/th')][1:]
    fields = {}
    for tr in table.xpath('./tbody/tr'):
        cells = tr.xpath('./td')
        if cells:
            name = " ".join(cells[0].text_content().replace("+", "").split())
            fields[name] = dict(zip(headers, (number(c.text_content()) for c in cells[1:])))
    return fields


def dated(table):
    periods = {}
    for values in table.values():
        for period in values:
            try:
                periods[period] = datetime.strptime(period,"%b %Y")
            except ValueError:
                continue
    return sorted(periods, key=periods.get, reverse=True)


def period_shift(period, months):
    d = datetime.strptime(period, "%b %Y")
    absolute = d.year*12 + d.month-1 + months
    return datetime(absolute//12, absolute%12+1, 1).strftime("%b %Y")


def ratio(a, b, factor=1):
    return a/b*factor if a is not None and b not in (None, 0) else None


def statement_columns(root):
    values = {}
    def put(key, value):
        if value is not None and isinstance(value,(int,float)) and math.isfinite(value):
            values[key] = value
    for item in root.xpath('//ul[@id="top-ratios"]/li'):
        label = " ".join(item.xpath('string(./span[@class="name"])').split())
        vals = [number(n.text_content()) for n in item.xpath('.//span[@class="number"]')]
        rename = {"Stock P/E":"Price to Earning","Market Cap":"Market Capitalization","Current Price":"Current price",
                  "Book Value":"Book value","Dividend Yield":"Dividend yield","ROCE":"Return on capital employed",
                  "ROE":"Return on equity","Face Value":"Face value","Industry PE":"Industry PE"}
        if vals and label in rename:
            put(rename[label], vals[0])
        if label=="High / Low" and len(vals)==2:
            put("High price",vals[0]); put("Low price",vals[1])

    pnl = {"Sales":("Sales","Revenue"), "Operating profit":("Operating Profit",),"Other income":("Other Income",),
           "Depreciation":("Depreciation",),"Interest":("Interest",),"Profit before tax":("Profit before tax",),
           "Net Profit":("Net Profit",),"Profit after tax":("Profit after tax","PAT excluding extraordinary items"),
           "Tax":("Tax","Tax expense"), "Equity Capital":("Equity Capital",),"Minority share":("Minority interest",),
           "Current Tax":("Current tax",),"Dividend":("Dividend",),
           "Extraordinary items":("Extraordinary Items",),"EPS":("EPS in Rs",),"OPM":("OPM %",)}
    for section, step, periods in (("profit-loss",12,[(0,"last year"),(1,"preceding year")]),
                                  ("quarters",3,[(0,"latest quarter"),(1,"preceding quarter"),(2,"2quarters back"),
                                                 (3,"3quarters back"),(4,"preceding year quarter")])):
        table = sheet(root,section)
        dates = dated(table)
        if not dates:
            continue
        @lru_cache(maxsize=32)
        def metrics(p):
            row = {name:next((table[k][p] for k in aliases if table.get(k,{}).get(p) is not None),None)
                   for name,aliases in pnl.items()}
            profit, interest, depreciation = (row[k] for k in ("Profit before tax","Interest","Depreciation"))
            if profit is not None and interest is not None:
                row["EBIT"] = profit + interest
                if depreciation is not None:
                    row["EBIDT"] = row["EBIT"] + depreciation
            row["NPM"] = ratio(row["Net Profit"],row["Sales"],100)
            row["OPM"] = row["OPM"] if row["OPM"] is not None else ratio(row["Operating profit"],row["Sales"],100)
            return row
        for back, suffix in periods:
            for key,value in metrics(period_shift(dates[0],-step*back)).items():
                put(key+" "+suffix, value)
        if section=="quarters":
            for key,label in [("Sales","sales"),("Net Profit","profit")]:
                for back,prefix in ((4,"YOY Quarterly "+label+" growth"),(1,"QoQ "+("Sales" if key=="Sales" else "Profits"))):
                    a,b=metrics(dates[0])[key],metrics(period_shift(dates[0],-step*back))[key]
                    if a is not None and b is not None and b>0:
                        put(prefix,100*(a/b-1))
        else:
            for key,val in metrics("TTM").items():
                put("Net profit" if key=="Net Profit" else key,val)
            for key in ("EPS","Sales","Net Profit","EBIDT"):
                today=metrics(dates[0]).get(key)
                for years in (1,3,5,7,10):
                    old=metrics(period_shift(dates[0],-12*years)).get(key)
                    if old and old>0 and today is not None and today>=0:
                        name={"Net Profit":"Profit"}.get(key,key)+" growth"+(f" {years}Years" if years>1 else "")
                        put(name,100*((today/old)**(1/years)-1))

    groups = {
        "balance-sheet":{"Equity capital":"Equity Capital","Reserves":"Reserves","Debt":"Borrowings","Total Assets":"Total Assets",
                         "Balance sheet total":"Total Assets","Capital work in progress":"CWIP","Investments":"Investments",
                         "Net block":"Fixed Assets","Cash Equivalents":"Cash Equivalents","Inventory":"Inventories",
                         "Trade receivables":"Trade receivables","Trade Payables":"Trade Payables","Lease liabilities":"Lease liabilities"},
        "cash-flow":{"Cash from operations":"Cash from Operating Activity","Cash from investing":"Cash from Investing Activity",
                     "Cash from financing":"Cash from Financing Activity","Net cash flow":"Net Cash Flow",
                     "Free cash flow":"Free Cash Flow"},
        "ratios":{"Return on capital employed":"ROCE %","Debtor days":"Debtor Days",
                  "Cash Conversion Cycle":"Cash Conversion Cycle","Working Capital Days":"Working Capital Days",
                  "Days Payable Outstanding":"Days Payable","Days Inventory Outstanding":"Inventory Days"},
        "shareholding":{"Promoter holding":"Promoters","FII holding":"FIIs","DII holding":"DIIs",
                        "Public holding":"Public","Number of Shareholders":"No. of Shareholders"}}
    for section, mapping in groups.items():
        table = sheet(root,section)
        dates = dated(table)
        if not dates:
            continue
        for name,label in mapping.items():
            series = table.get(label,{})
            recent = series.get(dates[0])
            if section=="cash-flow":
                put(name+" last year", recent)
            else:
                put(name, recent)
            for years in (1,3,5,7,10):
                prior=series.get(period_shift(dates[0],-12*years))
                put(name+(" preceding year" if years==1 else f" {years}Years back"),prior)
                window=[series.get(period_shift(dates[0],-12*i)) for i in range(years)]
                if all(v is not None for v in window):
                    put(f"Average {name.lower()} {years}Years",mean(window))
                    if section=="cash-flow":
                        base={"Cash from operations":"Operating cash flow","Cash from investing":"Investing cash flow"}.get(name,name)
                        put(f"{base} {years}years",sum(window))
            if section=="shareholding":
                prior = series.get(period_shift(dates[0],-3))
                put(name+" preceding quarter",prior)
                if recent is not None and prior is not None:
                    put("Change in "+name.replace("Promoter","promoter"),recent-prior)
    if all(k in values for k in ("Equity capital","Reserves")):
        put("Net worth",values["Equity capital"]+values["Reserves"])
    for name,a,b in [("Price to book value","Current price","Book value"),("Debt to equity","Debt","Net worth"),
                     ("Price to Sales","Market Capitalization","Sales"),("Market Cap to Sales","Market Capitalization","Sales"),
                     ("Market cap to quarterly profit","Market Capitalization","Net Profit latest quarter"),
                     ("Interest Coverage Ratio","EBIT","Interest"),("Debt To Profit","Debt","Net profit")]:
        put(name,ratio(values.get(a),values.get(b)))
    # Published growth tables take precedence over a calculated approximation.
    for table in root.xpath('//table[contains(@class,"ranges-table")]'):
        heading = " ".join(table.xpath('string(.//th)').split())
        base={"Compounded Sales Growth":"Sales growth","Compounded Profit Growth":"Profit growth",
              "Stock Price CAGR":"Return over","Return on Equity":"Average return on equity"}.get(heading)
        if base:
            for tr in table.xpath('.//tr[td]'):
                td=tr.xpath('./td')
                if len(td)==2:
                    period=td[0].text_content().strip().rstrip(":")
                    if period.endswith(" Years") or period=="1 Year":
                        n=period.split()[0]
                        key=base+" "+n+("year" if n=="1" else "years") if base=="Return over" else base+" "+n+"Years"
                        put(key,number(td[1].text_content()))
    return values
