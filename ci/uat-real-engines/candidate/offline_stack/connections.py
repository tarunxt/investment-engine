"""Declarative connection candidates only. No create_engine/Redis connection.

Requires dedicated instances inside the reviewed private namespace. Fixed names
alone cannot prove the endpoint is isolated; infrastructure gates still apply.
"""
from sqlalchemy import URL


def postgres_spec(*,namespace_verified,secret_password):
    if namespace_verified is not True or not isinstance(secret_password,str) or not secret_password:
        raise ValueError('UAT database configuration denied')
    return dict(url=URL.create('postgresql+psycopg2',username='credx_uat',password=secret_password,
                host='127.0.0.1',port=15432,database='credx_uat'),
                pool_size=1,max_overflow=0,pool_timeout=2,pool_recycle=300,
                connect_args={'connect_timeout':2,'application_name':'credx-uat',
                    'options':'-c statement_timeout=2000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=2000'})


def redis_spec(*,namespace_verified):
    if namespace_verified is not True:raise ValueError('UAT Redis configuration denied')
    return dict(host='127.0.0.1',port=16379,db=0,max_connections=2,socket_timeout=2,
                socket_connect_timeout=2,decode_responses=False)
