"""Streamlit 대시보드

실행: streamlit run dashboard/app.py

화면
- 종목 선택, 상승 확률과 차트·뉴스·공시 하위 점수
- 주가·이동평균 차트, RSI·감성 점수 패널, 공시 마커
- SHAP 판단 근거, 오늘의 뉴스와 기사별 감성
- 백테스트 탭 (A~D vs Buy & Hold), 실전 성과 탭
"""
import streamlit as st

st.title("차트·뉴스·공시 융합 AI 주가 예측")
st.info("준비 중입니다.")
